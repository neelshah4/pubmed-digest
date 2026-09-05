/**
 * Subscribe intake: turns one GitHub Issue Form submission into a stored
 * subscriber. Invoked by .github/workflows/subscribe.yml, which owns the
 * GitHub-side effects (commenting, closing, locking the issue) — this script
 * parses, validates, writes the store, and prepares the comment text; it
 * never calls the GitHub API itself (kept to `gh` steps in the workflow, run
 * against a file this script writes, so no user-supplied text ever has to
 * pass through a shell string — see COMMENT_FILE below).
 *
 * Inputs (env):
 *   ISSUE_BODY    the raw issue body text (github.event.issue.body)
 *   ISSUE_NUMBER  for logging only
 *   COMMENT_FILE  path to write the comment markdown to (default: a scratch
 *                 file under $RUNNER_TEMP, falling back to CWD for local runs)
 * Output: writes `ok=true`/`ok=false` to $GITHUB_OUTPUT when that env var is
 * set (see docs.github.com/en/actions/using-workflows/workflow-commands-for-github-actions#setting-an-output-parameter
 * — "environment files" are a general write-a-file mechanism, not bash-only),
 * plus a one-line JSON summary on stdout for the workflow log.
 *
 * Store: imports loadUsers/saveUsers from ./store.ts (the backend selector —
 * Supabase when SUPABASE_URL is set, else the local file store), per the
 * project convention every other caller (cli-ingest.ts, cli-digest.ts)
 * already follows. Both are Promise-returning even on the file backend, so
 * every call below is awaited uniformly regardless of which backend is live.
 *
 * PRIVACY: on the file backend this writes to data/users.json, which is
 * gitignored (`data/*.json` in .gitignore) — subscriber emails are never
 * committed. That also means, absent SUPABASE_URL, a subscription recorded
 * here does not survive past this Actions run: the next run starts from a
 * fresh checkout of the committed repo, which does not include
 * data/users.json. That is the accepted phase-1 tradeoff described in the
 * README's Status section, not an oversight — set SUPABASE_URL (and
 * SUPABASE_SERVICE_KEY) as repo secrets once Supabase is provisioned and
 * this script durably persists subscribers with no code change.
 */
import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseIssueBody } from './signup-parse.ts';
import { loadUsers, saveUsers } from './store.ts';
import type { SignupPrefs, User } from './types.ts';

const issueBody = process.env.ISSUE_BODY ?? '';
const issueNumber = process.env.ISSUE_NUMBER ?? '';
const commentFile = process.env.COMMENT_FILE
  ?? join(mkdtempSync(join(tmpdir(), 'subscribe-')), 'comment.md');

function setOutput(name: string, value: string): void {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
}

function describePrefs(p: SignupPrefs): string {
  const rows: [string, string][] = [
    ['Email', p.email],
    ['Cadence', p.cadence],
    ['Templates', p.templates.join(', ')],
    ['Journal tier', p.journalTier],
    ['Publication types', p.pubTypes.length ? p.pubTypes.join(', ') : 'all (no restriction)'],
    ['Extra keywords', p.extraKeywords.length ? p.extraKeywords.join(', ') : 'none'],
    ['ORCID watch list', p.authors.length ? `${p.authors.length} author(s)` : 'none'],
  ];
  return rows.map(([k, v]) => `| ${k} | ${v} |`).join('\n');
}

const FOOTER = 'This issue is now closed and locked so an email address never sits in an open issue.';

const result = parseIssueBody(issueBody);

if (!result.ok) {
  const comment = [
    'This subscription request could not be processed:',
    '',
    ...result.errors.map((e) => `- ${e}`),
    '',
    'Please open a new subscription request with the fix.',
    '',
    FOOTER,
  ].join('\n');
  writeFileSync(commentFile, comment);
  setOutput('ok', 'false');
  setOutput('close_reason', 'not planned');
  console.log(JSON.stringify({ ok: false, issueNumber, errors: result.errors }));
  process.exit(0);
}

const { prefs } = result;
const users = await loadUsers();
const existing = users.find((u) => u.email.toLowerCase() === prefs.email.toLowerCase());

let user: User;
let isUpdate: boolean;
if (existing) {
  // Re-subscribing (e.g. the same person filing a second request to change
  // preferences) updates prefs in place rather than creating a duplicate
  // subscriber. Deliberately preserves id/verifiedAt/unsubToken: an already
  // confirmed address stays confirmed, and existing unsubscribe/confirm
  // links for it keep working.
  isUpdate = true;
  user = { ...existing, templates: prefs.templates, cadence: prefs.cadence, prefs };
} else {
  isUpdate = false;
  user = {
    id: `u_${randomUUID().slice(0, 8)}`,
    email: prefs.email,
    templates: prefs.templates,
    cadence: prefs.cadence,
    llmTier: false,
    prefs,
    // Left unset on purpose: the double-opt-in "pending" state (see
    // types.ts User.verifiedAt and cli-digest.ts's DRY-run check). No
    // confirmation email is dispatched by this script.
    unsubToken: randomUUID(),
  };
}

await saveUsers(isUpdate ? users.map((u) => (u.id === user.id ? user : u)) : [...users, user]);

// store.ts silently picks Supabase over the file backend whenever
// SUPABASE_URL is set (see src/store.ts) — the comment must say which one
// actually just ran, not always describe the phase-1 file backend.
const persistenceNote = process.env.SUPABASE_URL
  ? 'This was written to the Supabase-backed subscriber store, so it persists across future runs.'
  : 'This repository is still Phase 1 (file-backed — see the README\'s Status section): ' +
    'this request was written to the repo\'s local subscriber store, which is gitignored and ' +
    'does not persist across scheduled Actions runs until the Supabase backend (phase 2) is ' +
    'wired in. If a digest never arrives, that is why.';

const comment = [
  isUpdate
    ? `Thanks — this updated your existing subscription (${user.email}).`
    : `Thanks — your subscription request was recorded (${user.email}).`,
  '',
  '| Field | Value |',
  '|---|---|',
  describePrefs(prefs),
  '',
  persistenceNote,
  '',
  FOOTER,
].join('\n');
writeFileSync(commentFile, comment);
setOutput('ok', 'true');
setOutput('close_reason', 'completed');
console.log(JSON.stringify({ ok: true, isUpdate, id: user.id, email: user.email, issueNumber }));
