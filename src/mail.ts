/**
 * Resend integration: outbound digest + confirmation email, unsubscribe/confirm
 * URLs, bulk-sender compliance headers, retry-with-backoff, and send-day
 * staggering. No npm dependencies — Node builtins + global `fetch` only.
 *
 * Every shape below was verified against a live fetch of the source doc this
 * session (2026-09-05), not recalled from memory:
 *
 *  - Send endpoint, auth header, JSON body fields, `headers` shape, success
 *    response shape:
 *    https://resend.com/docs/api-reference/emails/send-email
 *  - HTTP status meanings — 422 is a validation/malformed-request error (not
 *    transient, must not be retried); 429/500/503 are transient:
 *    https://resend.com/docs/api-reference/errors
 *  - Default rate limit (10 req/s/team) that produces the 429s above:
 *    https://resend.com/docs/api-reference/rate-limit
 *  - Free-plan cap of 100 emails/day, 3,000/month (motivates sendWeekday):
 *    https://resend.com/pricing
 *  - One-click unsubscribe header syntax — List-Unsubscribe-Post's only legal
 *    value, List-Unsubscribe needing at least one HTTPS URI, multiple URIs
 *    comma-separated in angle brackets (`<https://...>, <mailto:...>`), and
 *    the "no cookies/auth on the POST" rule:
 *    https://www.rfc-editor.org/rfc/rfc8058 (see esp. sec. 3.1, 5, 8.2)
 *  - Google requiring RFC 8058 one-click headers from bulk senders (>=5000
 *    msgs/day to Gmail), a mailto-only header not qualifying, and a plain
 *    body link not needing to itself be one-click once the header is present:
 *    https://support.google.com/a/answer/14229414
 *
 * Mailgun's AUP double-opt-in requirement (never email an unconfirmed
 * address) is enforced in sendDigest itself — see the verifiedAt check below.
 *
 * unsubscribeUrl/confirmUrl are re-exported from ./urls.ts rather than built
 * here a second time: urls.ts is this repo's single source of truth for
 * public link shapes precisely so the digest body link, the List-Unsubscribe
 * header, and the confirmation email can't drift apart. (Its PUBLIC_BASE
 * currently points at a GitHub Pages URL that 404s — no Pages-deploy workflow
 * exists yet — so links are correct in shape but not yet live; that's a gap
 * in urls.ts/the Pages setup, outside this file's scope.)
 */
import { randomUUID } from 'node:crypto';
import type { Digest, User } from './types.ts';
import { renderSubject } from './render/email.ts';
import { unsubscribeUrl, confirmUrl, unsubscribeMailto } from './urls.ts';

export { unsubscribeUrl, confirmUrl };
export interface SendResult { ok: boolean; id?: string; status: number; error?: string }

const RESEND_ENDPOINT = 'https://api.resend.com/emails';

const RETRY_ATTEMPTS = 3;

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`[mail] ${name} is not set`);
  return v;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * attempt is 1-based: 300ms, 600ms, 1200ms, ... Read from env on every call
 * (rather than cached at module load) so tests can override MAIL_RETRY_BASE_MS
 * after import and aren't stuck waiting on production-length backoff delays.
 */
function backoffMs(attempt: number): number {
  const base = Number(process.env.MAIL_RETRY_BASE_MS ?? 300);
  return base * 2 ** (attempt - 1);
}

// ---------------------------------------------------------------------------
// Tokens & links
// ---------------------------------------------------------------------------

/**
 * A fresh unguessable per-user token for unsubscribe/confirm links (urls.ts
 * consumes u.unsubToken but does not mint it). Uses node:crypto randomUUID()
 * (CSPRNG-backed, RFC 4122 v4) rather than deriving anything from the email
 * address — an email-derived token would let anyone who knows (or guesses)
 * an address unsubscribe or "confirm" it.
 */
export function generateUnsubToken(): string {
  return randomUUID();
}

/**
 * List-Unsubscribe / List-Unsubscribe-Post, per RFC 8058.
 *   - List-Unsubscribe-Post's ABNF (sec. 3.1) permits exactly one value:
 *     "List-Unsubscribe=One-Click" — never anything else, never a URL.
 *   - List-Unsubscribe (sec. 3.2) "MUST contain one HTTPS URI. It MAY
 *     contain other non-HTTP/S URIs such as MAILTO:." Multiple URIs are
 *     comma-separated, each in angle brackets (sec. 8.2 shows the combined
 *     mailto+https form).
 *   - Google (support.google.com/a/answer/14229414) requires exactly this
 *     for any bulk sender, and explicitly disqualifies a mailto-only header.
 * The https URL (from urls.ts, the same one rendered as the visible body
 * link) is the one-click target; the mailto (also urls.ts) is the RFC-
 * permitted fallback for a client that only understands the older
 * List-Unsubscribe.
 */
function unsubscribeHeaders(u: User): Record<string, string> {
  return {
    'List-Unsubscribe': `<${unsubscribeUrl(u)}>, <${unsubscribeMailto(u)}>`,
    'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
  };
}

// ---------------------------------------------------------------------------
// Resend transport
// ---------------------------------------------------------------------------

interface ResendBody {
  from: string;
  to: string;
  subject: string;
  html: string;
  text: string;
  headers?: Record<string, string>;
}

/**
 * POST to Resend's send endpoint with retry-with-backoff.
 * https://resend.com/docs/api-reference/emails/send-email :
 *   POST https://api.resend.com/emails
 *   Authorization: Bearer <RESEND_API_KEY>
 *   Content-Type: application/json
 *   body: { from, to, subject, html, text, headers: {<name>: <value>, ...} }
 *   200 -> { id: "<uuid>" }
 * https://resend.com/docs/api-reference/errors : 429/500/503 are transient
 * (rate limit / server error) and worth retrying; 422 (and other 4xx) mean
 * the request itself is malformed and retrying it verbatim will only fail
 * the same way again — that's the case retries must NOT touch.
 */
async function postToResend(apiKey: string, body: ResendBody): Promise<SendResult> {
  let lastStatus = 0;
  let lastError = 'unknown error';

  for (let attempt = 1; attempt <= RETRY_ATTEMPTS; attempt++) {
    let res: Response;
    try {
      res = await fetch(RESEND_ENDPOINT, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });
    } catch (e) {
      // Network-level failure (DNS, connection reset, timeout): treat like a
      // transient 5xx and retry with the same backoff.
      lastStatus = 0;
      lastError = e instanceof Error ? e.message : String(e);
      if (attempt < RETRY_ATTEMPTS) { await sleep(backoffMs(attempt)); continue; }
      return { ok: false, status: lastStatus, error: lastError };
    }

    if (res.ok) {
      const data = await res.json().catch(() => ({}) as { id?: string });
      return { ok: true, id: data?.id, status: res.status };
    }

    lastStatus = res.status;
    lastError = await res.text().catch(() => res.statusText);

    const retryable = res.status === 429 || res.status >= 500;
    if (retryable && attempt < RETRY_ATTEMPTS) {
      await sleep(backoffMs(attempt));
      continue;
    }
    return { ok: false, status: lastStatus, error: lastError };
  }

  return { ok: false, status: lastStatus, error: lastError };
}

// ---------------------------------------------------------------------------
// Public sends
// ---------------------------------------------------------------------------

/**
 * Send the weekly/monthly digest. Refuses — with no network call — a user
 * whose double opt-in never completed (`verifiedAt` unset). This is the
 * enforcement point Mailgun's AUP requires ("never email an address that has
 * not confirmed"); putting it here rather than only at the call site means
 * every caller gets it for free, including any future one that forgets to
 * check.
 */
export async function sendDigest(u: User, d: Digest, html: string, text: string): Promise<SendResult> {
  if (!u.verifiedAt) return { ok: false, status: 0, error: 'unverified' };

  const apiKey = requireEnv('RESEND_API_KEY');
  const from = requireEnv('MAIL_FROM');

  const body: ResendBody = {
    from,
    to: u.email,
    subject: renderSubject(d),
    html,
    text,
    // Required on every digest (bulk/promotional mail) per Google's bulk-sender
    // rules; NOT sent on the transactional confirmation email below, which
    // Google's own guidance excludes from the one-click requirement.
    headers: unsubscribeHeaders(u),
  };
  return postToResend(apiKey, body);
}

/**
 * Send the double-opt-in confirmation link. Deliberately does not check
 * verifiedAt — this is the message that makes verifiedAt get set — and
 * carries no List-Unsubscribe headers, since it is a one-off transactional
 * message rather than the recurring bulk/promotional mail Google's policy
 * (support.google.com/a/answer/14229414) targets.
 */
export async function sendConfirmation(u: User, confirmLink: string): Promise<SendResult> {
  const apiKey = requireEnv('RESEND_API_KEY');
  const from = requireEnv('MAIL_FROM');

  const text = [
    'Confirm your Critical Care Literature Digest subscription',
    '',
    `Click to confirm: ${confirmLink}`,
    '',
    "If you didn't request this, ignore this email — you won't be subscribed.",
  ].join('\n');
  const html = [
    '<!doctype html><html><body style="font-family:sans-serif;font-size:14px;color:#111;">',
    '<p>Confirm your <strong>Critical Care Literature Digest</strong> subscription.</p>',
    `<p><a href="${confirmLink}">${confirmLink}</a></p>`,
    "<p style=\"color:#666;font-size:12px;\">If you didn't request this, ignore this email — you won't be subscribed.</p>",
    '</body></html>',
  ].join('');

  const body: ResendBody = {
    from,
    to: u.email,
    subject: 'Confirm your subscription',
    html,
    text,
  };
  return postToResend(apiKey, body);
}

// ---------------------------------------------------------------------------
// Send staggering
// ---------------------------------------------------------------------------

/**
 * Deterministic weekday (0=Sun..6=Sat) to send a given user's digest on.
 * Resend's and Mailgun's free tiers both cap sending at 100/day regardless
 * of the (much larger) monthly allowance — https://resend.com/pricing lists
 * "100 emails per day" on the Free plan, and Mailgun's Free plan is the same
 * 100/day. A weekly job that fires every subscriber's digest in one burst
 * (e.g. every Sunday night) hits that 100/day ceiling once the list passes
 * ~100 users even though the monthly total (up to 3,000 on Resend) has
 * headroom. Hashing the user id spreads each user onto the same weekday
 * every week (so a "weekly" cadence stays weekly per-user) while spreading
 * the total subscriber base across all 7 days.
 */
export function sendWeekday(userId: string): number {
  let h = 0;
  for (let i = 0; i < userId.length; i++) {
    h = (h * 31 + userId.charCodeAt(i)) >>> 0;
  }
  return h % 7;
}
