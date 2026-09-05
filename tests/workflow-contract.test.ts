/**
 * Guards the CI wiring.
 *
 * store.ts silently picks the local file store whenever SUPABASE_URL is unset.
 * On an ephemeral runner that means zero subscribers and a digest sent to nobody
 * — with a green checkmark. Three workflows read that variable and none of them
 * forwarded it. This asserts that every workflow running code which depends on a
 * secret actually passes that secret in.
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync, readdirSync } from 'node:fs';

const dir = new URL('../.github/workflows/', import.meta.url);
const wf = (f: string) => readFileSync(new URL(f, dir), 'utf8');
const all = readdirSync(dir).filter((f) => f.endsWith('.yml'));

/** Steps see job-level env too, so a plain file-wide check is the right scope. */
const forwards = (src: string, name: string) =>
  new RegExp(`${name}:\\s*\\$\\{\\{\\s*secrets\\.${name}\\s*\\}\\}`).test(src);

test('every workflow that runs the pipeline forwards the Supabase credentials', () => {
  for (const f of ['ingest.yml', 'digest.yml', 'subscribe.yml']) {
    const src = wf(f);
    assert.ok(forwards(src, 'SUPABASE_URL'),
      `${f} runs code that reads SUPABASE_URL but never passes it — it would silently use the file store`);
    assert.ok(forwards(src, 'SUPABASE_SERVICE_KEY'), `${f} does not forward SUPABASE_SERVICE_KEY`);
  }
});

test('the send path forwards its mail secrets', () => {
  const src = wf('digest.yml');
  for (const s of ['RESEND_API_KEY', 'MAIL_FROM']) {
    assert.ok(forwards(src, s), `digest.yml cannot send without ${s}`);
  }
});

test('the service key is never exposed to the browser', () => {
  const pages = wf('pages.yml');
  assert.ok(/SUPABASE_ANON_KEY/.test(pages), 'pages.yml must supply the anon key to the browser config');
  assert.ok(!/SUPABASE_SERVICE_KEY/.test(pages),
    'pages.yml must NEVER put the service key in a deployed artifact — it bypasses row-level security');
});

test('no workflow swallows a failure', () => {
  for (const f of all) {
    const src = wf(f);
    assert.ok(!/continue-on-error:\s*true/.test(src), `${f} sets continue-on-error, hiding failures`);
    // `|| true` on the pipeline steps would turn a broken run into a green one.
    for (const line of src.split('\n')) {
      if (/npm run (ingest|digest)/.test(line)) {
        assert.ok(!/\|\|\s*true/.test(line), `${f}: pipeline step masks its exit code`);
      }
    }
  }
});

test('the ingest job still commits a stamp, which is what keeps the cron alive', () => {
  // Scheduled workflows on a public repo are auto-disabled after 60 days with no
  // repository activity. The archive commit is the activity.
  const src = wf('ingest.yml');
  assert.ok(/last-ingest\.txt/.test(src), 'ingest.yml no longer writes the keepalive stamp');
  assert.ok(/git add -f data\/last-ingest\.txt/.test(src), 'the stamp is written but never committed');
});

test('subscriber PII is never staged by a workflow', () => {
  for (const f of all) {
    const src = wf(f);
    for (const bad of ['users.json', 'feedback.json', 'profiles.json']) {
      assert.ok(!new RegExp(`git add[^\\n]*${bad.replace('.', '\\.')}`).test(src),
        `${f} stages ${bad}, which holds subscriber data`);
    }
    assert.ok(!/git add -f data\/\s*$/m.test(src), `${f} stages all of data/, which would include PII`);
  }
});
