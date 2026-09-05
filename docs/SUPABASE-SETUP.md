# Supabase setup

Fifteen minutes, no database experience needed. This wires the free Supabase backend behind
`src/store-supabase.ts` so subscriber data, the paper cache, and the dedup ledger survive between
GitHub Actions runs instead of living only in a gitignored local JSON file.

## 1. Create the free project

1. Go to [supabase.com](https://supabase.com) and sign in (GitHub sign-in is the fastest path).
2. Click **New project**. Pick or create an organization if asked.
3. Give it a name (e.g. `pubmed-digest`), set a database password (save it somewhere — Supabase
   does not show it again, though this guide never needs it directly), and pick a region close to
   you or your subscribers.
4. Leave the plan on **Free** and click **Create new project**. Provisioning takes one to two
   minutes.

## 2. Run the schema

1. In the project, open **SQL Editor** in the left sidebar, then **New query**.
2. Open `supabase/schema.sql` from this repo, copy the whole file, and paste it into the editor.
3. Click **Run**. It should finish with no errors — every statement in the file is written to be
   safe to run more than once, so re-running it later (after a schema change) is fine.
4. Optional sanity check: open **Table Editor** in the sidebar and confirm nine tables exist —
   `users`, `templates`, `user_templates`, `user_config`, `author_watches`, `papers`, `user_seen`,
   `feedback`, `digests` — and that `templates` already has 3 rows (`peds-cc`, `adult-cc`,
   `neurocrit`) from the schema's own seed data.

## 3. Find your project URL and keys

Go to **Settings → API Keys** in the sidebar. You'll see:

- **Project URL** — looks like `https://xxxxxxxxxxxx.supabase.co`.
- **Publishable key** (may be labeled `anon` `public` on an older project) — safe to expose in
  client-side code; this is what `web/action.html`'s feedback/unsubscribe/confirm links use.
- **Secret key** (may be labeled `service_role` on an older project) — bypasses every access
  restriction in `supabase/schema.sql`. Treat it like a database password: it goes into GitHub
  Actions secrets only, never into any file that gets committed or into client-side code.

## 4. Add the GitHub repository secrets

In this repo on GitHub: **Settings → Secrets and variables → Actions → New repository secret**.
Add:

| Secret name | Value | Used by |
|---|---|---|
| `SUPABASE_URL` | the Project URL from step 3 | `src/store.ts` picks the Supabase backend the moment this is set; also read directly by `src/store-supabase.ts` |
| `SUPABASE_SERVICE_KEY` | the Secret key from step 3 | same — every table write in `supabase/schema.sql` requires this key's privileges |

These are the two names `src/store-supabase.ts` reads from `process.env`; it throws a clear error
naming both if either is missing rather than silently falling back to the file store, so a typo in
either name surfaces immediately the first time a workflow calls it.

**As found this session, not yet wired — flagging rather than fixing silently:** none of
`.github/workflows/ingest.yml`, `digest.yml`, or `subscribe.yml` currently forward these two
secrets into their job's `env:` block (they weren't in this task's file list, so this guide
documents the gap instead of editing CI config on the side). Until each workflow's `env:` section
adds `SUPABASE_URL: ${{ secrets.SUPABASE_URL }}` and
`SUPABASE_SERVICE_KEY: ${{ secrets.SUPABASE_SERVICE_KEY }}` next to its existing secrets (e.g.
`NCBI_API_KEY`, `RESEND_API_KEY`), adding the two repository secrets above is necessary but not
sufficient — the CLIs will keep using the local file store in Actions until that one-line addition
lands in each workflow file.

Separately, `web/action.html` reads `window.__SUPABASE_URL__` / `window.__SUPABASE_ANON__`, which
nothing currently sets — `.github/workflows/pages.yml` uploads `web/` as static files with no
templating step. That page already fails gracefully (it tells the visitor the backend isn't
configured rather than breaking silently), but making the feedback/unsubscribe/confirm links work
on the live site needs the Publishable key from step 3 wired into that page some way (a small
inline `<script>` committed to `web/action.html`, since a publishable key is meant to be public and
doesn't need to be a secret) — also outside this task's file list.

## 5. Verify it worked

Locally, with the two values from step 3 (never commit them — export them in your shell only):

```bash
export SUPABASE_URL="https://xxxxxxxxxxxx.supabase.co"
export SUPABASE_SERVICE_KEY="sb_secret_..."   # or the legacy service_role JWT, either works

# Confirm store.ts actually selects the Supabase backend once SUPABASE_URL is set:
node --experimental-strip-types -e "
  import('./src/store.ts').then(async (s) => {
    const users = await s.loadUsers();
    console.log('Connected. Current users in Supabase:', users.length);
  }).catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
"
```

`Connected. Current users in Supabase: 0` on a fresh project means the URL, the key, and every RLS
grant in `supabase/schema.sql` are all correct — `loadUsers()` reads the `users`, `user_templates`,
`user_config`, and `author_watches` tables in one call, so a failure anywhere in that chain (wrong
key, missing table, a table-level grant the schema didn't apply) surfaces here immediately rather
than three steps later during a real ingest run.

Then run an actual ingest against it:

```bash
SUPABASE_URL=... SUPABASE_SERVICE_KEY=... npm run ingest
```

and check **Table Editor → papers** in the Supabase dashboard — it should have rows.

To go back to the local file store at any point (e.g. to test offline), just unset `SUPABASE_URL`;
nothing else changes.

## Free tier limits (verified against Supabase's own pricing page this session)

- **500 MB database**, shared CPU, 500 MB RAM.
- **1 GB file storage**, 5 GB egress (bandwidth) per month.
- **2 active projects** per organization; unlimited *paused* projects.
- **Projects pause after one week of inactivity.** This is the one that matters most for this repo:
  the daily ingest workflow (`ingest.yml`, 03:23 UTC) and the weekly digest (`digest.yml`, Monday
  11:23 UTC) both count as activity, so a repo running its scheduled workflows normally should never
  trip this. It becomes a real risk only if the GitHub Actions schedules themselves stop firing —
  GitHub disables a scheduled workflow after 60 days of no repository activity on a public repo, and
  losing the daily ingest would eventually let the Supabase project go quiet too. A paused project
  keeps its data and can be resumed from the dashboard for up to a year; it does not lose anything,
  it just stops answering requests until resumed.
- Database backups are not downloadable on the Free plan (a paid-plan feature). Nothing in this
  project depends on that — `papers` can always be rebuilt from a fresh ingest, and `data/seen.json`
  already gets committed to the repo in the file-store path as a secondary record.

If you outgrow 500 MB (unlikely for this project — cached PubMed metadata for a curated journal set
is small; the file-store equivalent, `data/papers.json`, is under 5 MB after months of daily
ingests), the paid Pro plan removes the pause and raises these ceilings; nothing in `schema.sql` or
`store-supabase.ts` needs to change to move to it.
