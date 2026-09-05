/**
 * Guards the seam between the emailed links and the database.
 *
 * A reader clicking from an email has no session, so row-level security refuses
 * a plain insert. Every action link therefore has to carry an unguessable token,
 * and the database side has to expose a function that authorises on it. These
 * two halves were written against different assumptions and did not line up.
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { feedbackUrl, feedbackBaseUrl, unsubscribeUrl, confirmUrl } from '../src/urls.ts';

const u = { id: 'u-123', unsubToken: '0d2154a1-2d29-4adf-ae87-9ed2089198b4' };
const other = { id: 'u-999', unsubToken: 'ffffffff-2d29-4adf-ae87-9ed2089198b4' };

test('every action link carries the token', () => {
  for (const url of [feedbackBaseUrl(u), feedbackUrl(u, '123', 'star'), unsubscribeUrl(u), confirmUrl(u)]) {
    assert.ok(url.includes(`t=${u.unsubToken}`), `missing token: ${url}`);
  }
});

test('no email address ever appears in an action link', () => {
  for (const url of [feedbackUrl(u, '123', 'skip'), unsubscribeUrl(u), confirmUrl(u)]) {
    assert.ok(!url.includes('@'), `email leaked into ${url}`);
  }
});

test('tokens differ per user, so one link cannot act on another account', () => {
  assert.notStrictEqual(unsubscribeUrl(u), unsubscribeUrl(other));
});

test('the schema exposes exactly the RPCs the action page calls', () => {
  const sql = readFileSync(new URL('../supabase/schema.sql', import.meta.url), 'utf8');
  const page = readFileSync(new URL('../web/action.html', import.meta.url), 'utf8');
  for (const fn of ['record_feedback', 'unsubscribe', 'confirm_subscription']) {
    assert.ok(new RegExp(`create or replace function ${fn}\\b`, 'i').test(sql), `schema missing ${fn}()`);
    assert.ok(new RegExp(`grant execute on function ${fn}\\b`, 'i').test(sql), `${fn}() not granted to anon`);
  }
  for (const call of page.matchAll(/post\('rpc\/(\w+)'/g)) {
    assert.ok(new RegExp(`function ${call[1]}\\b`, 'i').test(sql),
      `action.html calls rpc/${call[1]} but the schema defines no such function`);
  }
});

test('every SECURITY DEFINER function pins its search_path', () => {
  const sql = readFileSync(new URL('../supabase/schema.sql', import.meta.url), 'utf8');
  const defs = sql.split(/create or replace function/i).slice(1);
  const definers = defs.filter((d) => /security definer/i.test(d));
  assert.ok(definers.length >= 3, 'expected the three token-authenticated functions');
  for (const d of definers) {
    assert.ok(/set search_path\s*=/i.test(d.split('$$')[0]),
      'a SECURITY DEFINER function without a pinned search_path is a privilege-escalation route');
  }
});

test('the action page refuses a feedback link with no token', () => {
  const page = readFileSync(new URL('../web/action.html', import.meta.url), 'utf8');
  assert.ok(/!user\s*\|\|\s*!token/.test(page.replace(/\s+/g, ' ')),
    'feedback path must require a token before posting');
});
