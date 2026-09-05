/**
 * src/mail.ts tests. globalThis.fetch is always stubbed here — no test in this
 * file ever makes a real network call, and each test restores the original
 * fetch afterward so other test files are unaffected.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  sendDigest, sendConfirmation, unsubscribeUrl, confirmUrl, sendWeekday, generateUnsubToken,
} from '../src/mail.ts';
import type { User, Digest } from '../src/types.ts';

const ORIGINAL_FETCH = globalThis.fetch;

function mkUser(overrides: Partial<User> = {}): User {
  return {
    id: 'user-1',
    email: 'reader@example.com',
    templates: ['peds-cc'],
    cadence: 'weekly',
    llmTier: false,
    verifiedAt: '2026-01-01T00:00:00.000Z',
    unsubToken: generateUnsubToken(),
    ...overrides,
  };
}

const digest: Digest = {
  userId: 'user-1',
  generatedAt: '2026-09-05T00:00:00.000Z',
  windowDays: 7,
  sections: [],
  practiceChanging: [],
  borderline: [],
  totalCandidates: 12,
  totalAfterFilter: 4,
  authorPapers: [],
};

function fakeResponse(status: number, body: unknown): Response {
  const ok = status >= 200 && status < 300;
  return {
    ok,
    status,
    statusText: String(status),
    json: async () => body,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  } as unknown as Response;
}

interface Call { url: string; init: Record<string, any> }

/** Queue of canned responses, consumed in order; the last one repeats if exhausted. */
function stubFetch(responses: Response[]): { calls: Call[]; restore: () => void } {
  const calls: Call[] = [];
  let i = 0;
  (globalThis as any).fetch = async (url: string, init: Record<string, any>) => {
    calls.push({ url, init });
    const r = responses[Math.min(i, responses.length - 1)];
    i++;
    return r;
  };
  return { calls, restore: () => { globalThis.fetch = ORIGINAL_FETCH; } };
}

/** Fails the test if fetch is called at all. */
function stubNoFetch(): { calls: Call[]; restore: () => void } {
  const calls: Call[] = [];
  (globalThis as any).fetch = async (url: string, init: Record<string, any>) => {
    calls.push({ url, init });
    throw new Error('fetch must not be called');
  };
  return { calls, restore: () => { globalThis.fetch = ORIGINAL_FETCH; } };
}

// NOTE: must `await fn()` inside the try — `return fn()` would let `finally`
// restore the env synchronously, before an async test body actually runs.
async function withEnv<T>(vars: Record<string, string>, fn: () => T | Promise<T>): Promise<T> {
  const prev: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) { prev[k] = process.env[k]; process.env[k] = vars[k]; }
  try {
    return await fn();
  } finally {
    for (const k of Object.keys(vars)) {
      if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k];
    }
  }
}

const BASE_ENV = { RESEND_API_KEY: 'test_key_123', MAIL_FROM: 'Digest <digest@example.com>', MAIL_RETRY_BASE_MS: '5' };

// ---------------------------------------------------------------------------
// Double opt-in enforcement
// ---------------------------------------------------------------------------

test('sendDigest refuses an unverified user with no network call', async () => {
  await withEnv(BASE_ENV, async () => {
    const { calls, restore } = stubNoFetch();
    try {
      const u = mkUser({ verifiedAt: undefined });
      const r = await sendDigest(u, digest, '<html></html>', 'plain text');
      assert.equal(r.ok, false);
      assert.equal(r.error, 'unverified');
      assert.equal(calls.length, 0);
    } finally { restore(); }
  });
});

// ---------------------------------------------------------------------------
// Success path
// ---------------------------------------------------------------------------

test('a 200 response returns ok:true with the message id', async () => {
  await withEnv(BASE_ENV, async () => {
    const { calls, restore } = stubFetch([fakeResponse(200, { id: 'msg-abc-123' })]);
    try {
      const u = mkUser();
      const r = await sendDigest(u, digest, '<html></html>', 'plain text');
      assert.equal(r.ok, true);
      assert.equal(r.id, 'msg-abc-123');
      assert.equal(r.status, 200);
      assert.equal(calls.length, 1);

      const [{ url, init }] = calls;
      assert.equal(url, 'https://api.resend.com/emails');
      assert.equal(init.method, 'POST');
      assert.equal(init.headers.Authorization, 'Bearer test_key_123');
      assert.equal(init.headers['Content-Type'], 'application/json');

      const body = JSON.parse(init.body);
      assert.equal(body.from, BASE_ENV.MAIL_FROM);
      assert.equal(body.to, u.email);
      assert.equal(body.html, '<html></html>');
      assert.equal(body.text, 'plain text');
    } finally { restore(); }
  });
});

// ---------------------------------------------------------------------------
// Retry semantics
// ---------------------------------------------------------------------------

test('a 429 is retried and a later success is returned', async () => {
  await withEnv(BASE_ENV, async () => {
    const { calls, restore } = stubFetch([
      fakeResponse(429, 'rate limited'),
      fakeResponse(200, { id: 'retried-ok' }),
    ]);
    try {
      const u = mkUser();
      const r = await sendDigest(u, digest, '<html></html>', 'plain text');
      assert.equal(r.ok, true);
      assert.equal(r.id, 'retried-ok');
      assert.equal(calls.length, 2, 'expected exactly one retry after the 429');
    } finally { restore(); }
  });
});

test('repeated 5xx errors exhaust retries and return a structured failure, not a throw', async () => {
  await withEnv(BASE_ENV, async () => {
    const { calls, restore } = stubFetch([fakeResponse(503, 'down'), fakeResponse(503, 'down'), fakeResponse(503, 'down')]);
    try {
      const u = mkUser();
      const r = await sendDigest(u, digest, '<html></html>', 'plain text');
      assert.equal(r.ok, false);
      assert.equal(r.status, 503);
      assert.equal(calls.length, 3, 'should attempt exactly 3 times total, then give up');
    } finally { restore(); }
  });
});

test('a 422 (malformed request) is NOT retried', async () => {
  await withEnv(BASE_ENV, async () => {
    const { calls, restore } = stubFetch([fakeResponse(422, JSON.stringify({ message: 'invalid `to` field' }))]);
    try {
      const u = mkUser();
      const r = await sendDigest(u, digest, '<html></html>', 'plain text');
      assert.equal(r.ok, false);
      assert.equal(r.status, 422);
      assert.equal(calls.length, 1, '422 is a client error and must not be retried');
    } finally { restore(); }
  });
});

test('a 401 (bad key) is also NOT retried', async () => {
  await withEnv(BASE_ENV, async () => {
    const { calls, restore } = stubFetch([fakeResponse(401, 'unauthorized')]);
    try {
      const r = await sendDigest(mkUser(), digest, '<html></html>', 'plain text');
      assert.equal(r.ok, false);
      assert.equal(r.status, 401);
      assert.equal(calls.length, 1);
    } finally { restore(); }
  });
});

// ---------------------------------------------------------------------------
// Compliance headers (RFC 8058 + Google bulk-sender guidance)
// ---------------------------------------------------------------------------

test('List-Unsubscribe and List-Unsubscribe-Post are present and well-formed on a digest send', async () => {
  await withEnv(BASE_ENV, async () => {
    const { calls, restore } = stubFetch([fakeResponse(200, { id: 'x' })]);
    try {
      const u = mkUser();
      await sendDigest(u, digest, '<html></html>', 'plain text');
      const body = JSON.parse(calls[0].init.body);
      const headers = body.headers;

      // RFC 8058 sec. 3.1: this is the ONLY legal List-Unsubscribe-Post value.
      assert.equal(headers['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click');

      const lu: string = headers['List-Unsubscribe'];
      // RFC 8058 sec. 3.2: must contain at least one HTTPS URI, angle-bracketed.
      assert.match(lu, /<https:\/\/[^>]+>/);
      // Multiple URIs are comma-separated per RFC 8058 sec. 8.2's combined example.
      assert.match(lu, /<https:\/\/[^>]+>,\s*<mailto:[^>]+>/);
      // A mailto-only header does not satisfy Google's requirement, so the https
      // form must be the one actually reachable via unsubscribeUrl(u).
      assert.ok(lu.includes(unsubscribeUrl(u)));
    } finally { restore(); }
  });
});

test('sendConfirmation carries no List-Unsubscribe headers (transactional, not bulk/promotional)', async () => {
  await withEnv(BASE_ENV, async () => {
    const { calls, restore } = stubFetch([fakeResponse(200, { id: 'confirm-1' })]);
    try {
      const u = mkUser({ verifiedAt: undefined });
      const link = confirmUrl(u);
      const r = await sendConfirmation(u, link);
      assert.equal(r.ok, true);
      const body = JSON.parse(calls[0].init.body);
      assert.equal(body.headers, undefined);
      assert.ok(body.html.includes(link));
      assert.ok(body.text.includes(link));
    } finally { restore(); }
  });
});

// ---------------------------------------------------------------------------
// Tokens / URLs
// ---------------------------------------------------------------------------

test('unsubscribeUrl differs across users and never contains the raw email address', () => {
  const alice = mkUser({ id: 'user-alice', email: 'alice@example.com' });
  const bob = mkUser({ id: 'user-bob', email: 'bob@example.com' });

  const aliceUrl = unsubscribeUrl(alice);
  const bobUrl = unsubscribeUrl(bob);

  assert.notEqual(aliceUrl, bobUrl);
  assert.ok(!aliceUrl.toLowerCase().includes('alice@example.com'));
  assert.ok(!aliceUrl.toLowerCase().includes(encodeURIComponent('alice@example.com')));
  assert.ok(!bobUrl.toLowerCase().includes('bob@example.com'));
});

test('unsubscribeUrl is not guessable from the email address alone (two users, same email-derived-looking id, different tokens)', () => {
  const a = mkUser({ id: 'same-id', unsubToken: generateUnsubToken() });
  const b = mkUser({ id: 'same-id', unsubToken: generateUnsubToken() });
  assert.notEqual(unsubscribeUrl(a), unsubscribeUrl(b), 'the token, not just the id, must drive the URL');
});

test('generateUnsubToken produces unguessable, unique-looking tokens (not derived from an email)', () => {
  const a = generateUnsubToken();
  const b = generateUnsubToken();
  assert.notEqual(a, b);
  // RFC 4122 v4 UUID shape from node:crypto randomUUID().
  assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
});

// ---------------------------------------------------------------------------
// Send-day staggering
// ---------------------------------------------------------------------------

test('sendWeekday is stable for the same user id', () => {
  assert.equal(sendWeekday('user-123'), sendWeekday('user-123'));
  assert.equal(sendWeekday('another-user'), sendWeekday('another-user'));
});

test('sendWeekday returns a value in [0, 6] and spreads many ids across most weekdays', () => {
  const seen = new Set<number>();
  for (let i = 0; i < 500; i++) {
    const day = sendWeekday(`subscriber-${i}`);
    assert.ok(Number.isInteger(day) && day >= 0 && day <= 6);
    seen.add(day);
  }
  assert.ok(seen.size >= 5, `expected sends spread across most of the week, only hit ${seen.size} distinct days`);
});

// ---------------------------------------------------------------------------
// Missing configuration
// ---------------------------------------------------------------------------

test('sendDigest throws a clear error when RESEND_API_KEY is unset', async () => {
  await withEnv({ RESEND_API_KEY: '', MAIL_FROM: 'Digest <digest@example.com>' }, async () => {
    delete process.env.RESEND_API_KEY;
    const { restore } = stubNoFetch();
    try {
      await assert.rejects(
        () => sendDigest(mkUser(), digest, '<html></html>', 'text'),
        /RESEND_API_KEY/,
      );
    } finally { restore(); }
  });
});

test('sendDigest throws a clear error when MAIL_FROM is unset', async () => {
  process.env.RESEND_API_KEY = 'test_key_123';
  delete process.env.MAIL_FROM;
  const { restore } = stubNoFetch();
  try {
    await assert.rejects(
      () => sendDigest(mkUser(), digest, '<html></html>', 'text'),
      /MAIL_FROM/,
    );
  } finally { restore(); delete process.env.RESEND_API_KEY; }
});
