/** Weekly digest: score cached papers per user -> render -> (send | dry-run). */
import { mkdirSync, writeFileSync } from 'node:fs';
import { existsSync, readFileSync } from 'node:fs';
import { configFor, DEFAULT_PREFS } from './prefs.ts';
import { feedbackBaseUrl, unsubscribeUrl, PUBLIC_BASE } from './urls.ts';
import { buildDigest } from './score/score.ts';
import { renderDigestHtml, renderDigestText, renderSubject } from './render/email.ts';
import { papersSince, loadUsers, markSeen, hasSeen, loadProfile } from './store.ts';
import { sendDigest } from './mail.ts';

const DRY = process.env.DRY_RUN !== 'false';
const days = Number(process.env.DAYS ?? 7);
const users = await loadUsers();
const authorHits = new Map<string, { orcid: string; label?: string }>(
  existsSync('data/author-hits.json')
    ? Object.entries(JSON.parse(readFileSync('data/author-hits.json', 'utf8')))
    : [],
) as Map<string, { orcid: string; label?: string }>;
if (users.length === 0) { console.error('[digest] no users configured'); process.exit(1); }

mkdirSync('out', { recursive: true });

for (const u of users) {
  // A real send only ever reaches a confirmed (double-opt-in) address; sendDigest()
  // enforces this too, but skipping here also spares an unverified user the
  // scoring/render work on every --send run. A dry run still previews everyone,
  // verified or not, so a signup can be checked locally before it confirms.
  if (!DRY && !u.verifiedAt) {
    console.log(`[digest] ${u.email}: skipped (unverified)`);
    continue;
  }

  const prefs = { ...DEFAULT_PREFS, ...(u.prefs ?? {}), email: u.email,
                  templates: u.prefs?.templates ?? u.templates ?? ['peds-cc'] };
  let cfg = configFor(prefs);
  const lp = await loadProfile(u.id);
  if (lp) cfg = { ...cfg, preference_profile: { ...cfg.preference_profile, learned_profile: lp } };

  const seen = await hasSeen(u.id);
  const pool = (await papersSince(days)).filter((p) => !seen.has(p.pmid));
  const d = buildDigest(pool, cfg, u.id, days, { prefs, authorHits, email: u.email });

  const shown = [...d.authorPapers, ...d.practiceChanging, ...d.sections.flatMap((s) => s.papers)];
  const renderOpts = {
    unsubscribeUrl: unsubscribeUrl(u),
    feedbackBaseUrl: feedbackBaseUrl(u),
    userEmail: u.email,
  };
  const html = renderDigestHtml(d, renderOpts);
  const text = renderDigestText(d, renderOpts);
  writeFileSync(`out/digest-${u.id}.html`, html);
  writeFileSync(`out/digest-${u.id}.txt`, text);

  console.log(`[digest] ${u.email}: pool=${pool.length} kept=${d.totalAfterFilter} ` +
    `authors=${d.authorPapers.length} shown=${shown.length} -> out/digest-${u.id}.html`);
  console.log(`         subject: ${renderSubject(d)}`);

  if (!DRY) {
    let r;
    try {
      r = await sendDigest(u, d, html, text);
    } catch (e) {
      console.error(`[digest] FATAL: ${e instanceof Error ? e.message : e}`);
      process.exit(1);
    }
    if (!r.ok) { console.error(`[digest] send failed for ${u.email} (${r.status}): ${r.error}`); process.exit(1); }
    await markSeen(u.id, shown.map((s) => s.paper.pmid));
  }
}
console.log(DRY ? '[digest] DRY RUN — nothing sent' : '[digest] sent');
