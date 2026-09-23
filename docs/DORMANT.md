# Dormant since 2026-09-23

This project is paused. Both scheduled jobs are off; the code is intact and tested
(87/87 passing at shelving). Nothing here is broken. The setup was simply never finished.

**Not to be confused with** the personal weekly digest that shares this name: launchd
job `com.neel.pubmed-digest`, Sundays 22:00 America/Chicago, which sends the real email and
feeds Zotero and the reading library. That system is separate, still running, and never
read from this repo.

## Why it was paused

The Digest workflow failed on all three scheduled runs (2026-09-07, 09-14, 09-21) with
`[digest] no users configured`. No repository secrets were ever set, so `src/store.ts` fell
back to the local file store, and on a GitHub runner that store is empty because
`data/users.json` is gitignored. Ingest ran green nightly, but nothing consumed its output.

## State at shelving

| What | Where | State |
|---|---|---|
| `digest.yml` | Actions | schedule commented out, manual trigger kept |
| `ingest.yml` | Actions | schedule commented out, manual trigger kept |
| `pages.yml` | Actions | runs only on a push to `web/**` |
| `subscribe.yml` | Actions | runs on any new or edited issue |
| Signup page | GitHub Pages, `/pubmed-digest/` | see the note under "Open item" below |
| Paper cache | `data/papers.json` (in git) | 3,836 papers, last ingest 2026-09-23T03:34:53Z |
| Subscriber + prefs | `data/users.json` (gitignored) | 1 verified user, local clone only |
| Author follows | `data/author-hits.json` (gitignored) | local clone only |
| Backup of both | `~/.claude/backups/pubmed-digest-dormant-2026-09-23/` | mode 600, checksums match the originals |
| Repository secrets | Settings → Secrets | none set |
| Signup issues | Issues | none ever filed, so no subscriber was lost |

The paper cache goes stale from the last-ingest date. That is harmless: on resume, one
manual Ingest run with a wider `days` window refills it.

## Open item

The signup page stayed live when the jobs were paused. With no Supabase, a signup is
accepted and then lost on the ephemeral runner. If the page is still up, unpublish it:
`gh api -X DELETE repos/neelshah4/pubmed-digest/pages`, then disable `subscribe.yml`.

## To resume

Work in this order. Each step is checkable before the next.

1. **Decide that you want two digests.** The personal launchd digest keeps running. Once
   this one sends too, you get both each week. Pick one to keep, or run this one for other
   people only.
2. **Supabase.** Follow `docs/SUPABASE-SETUP.md` (create the project, run
   `supabase/schema.sql`, collect the URL and keys). Its section 5 verifies the backend switch.
3. **Secrets.** Set every row of the table in the README under "To put it online".
   `SUPABASE_URL` and `SUPABASE_SERVICE_KEY` are what fix the original failure.
4. **Sending.** Resend API key, `MAIL_FROM`, and a sending domain with SPF, DKIM and DMARC
   records (email authentication, so mail isn't filed as spam).
5. **Label.** Create the `subscription` issue label, or signup issues won't be tagged.
6. **Re-publish the signup page** if it was taken down: re-enable Pages (source: GitHub
   Actions), then run the Pages workflow manually.
7. **Re-subscribe.** No script moves file-store users into Supabase. Sign up again through
   the form; the preferences in the backed-up `users.json` show what to re-enter.
8. **Check it by hand, dry first.**
   - `npm test`, which should still pass 87/87.
   - Actions → Ingest → Run workflow, with `days` covering the gap since the last ingest.
   - Actions → Digest → Run workflow with `dry_run` checked. Download the `rendered-digest`
     artifact and read it. The log must not say `no users configured`.
   - Run Digest again with `dry_run` unchecked, one real send to yourself.
9. **Re-enable the schedules.** Uncomment the two `schedule:` lines in `ingest.yml` and
   `digest.yml`, commit, push. Then run `gh workflow list --all`. GitHub disables scheduled
   workflows after 60 days with no repository activity, and a paused repo will pass that
   mark. Run `gh workflow enable Ingest` and `gh workflow enable Digest` for any workflow
   listed as disabled.
