/** Weekly digest: score cached papers per user -> render -> (send | dry-run). */
import { mkdirSync, writeFileSync } from 'node:fs';
import { existsSync, readFileSync } from 'node:fs';
import { configFor, DEFAULT_PREFS } from './prefs.ts';
import { buildDigest } from './score/score.ts';
import { renderDigestHtml, renderDigestText, renderSubject } from './render/email.ts';
import { papersSince, loadUsers, markSeen, hasSeen, loadProfile } from './state.ts';

const DRY = process.env.DRY_RUN !== 'false';
const days = Number(process.env.DAYS ?? 7);
const users = loadUsers();
const authorHits = new Map<string, { orcid: string; label?: string }>(
  existsSync('data/author-hits.json')
    ? Object.entries(JSON.parse(readFileSync('data/author-hits.json', 'utf8')))
    : [],
) as Map<string, { orcid: string; label?: string }>;
if (users.length === 0) { console.error('[digest] no users configured'); process.exit(1); }

mkdirSync('out', { recursive: true });

for (const u of users) {
  const prefs = { ...DEFAULT_PREFS, ...(u.prefs ?? {}), email: u.email,
                  templates: u.prefs?.templates ?? u.templates ?? ['peds-cc'] };
  let cfg = configFor(prefs);
  const lp = loadProfile(u.id);
  if (lp) cfg = { ...cfg, preference_profile: { ...cfg.preference_profile, learned_profile: lp } };

  const seen = hasSeen(u.id);
  const pool = papersSince(days).filter((p) => !seen.has(p.pmid));
  const d = buildDigest(pool, cfg, u.id, days, { prefs, authorHits, email: u.email });

  const shown = [...d.authorPapers, ...d.practiceChanging, ...d.sections.flatMap((s) => s.papers)];
  const html = renderDigestHtml(d, {
    unsubscribeUrl: `https://example.invalid/unsubscribe?u=${u.id}`,
    feedbackBaseUrl: 'https://example.invalid/feedback',
    userEmail: u.email,
  });
  writeFileSync(`out/digest-${u.id}.html`, html);
  writeFileSync(`out/digest-${u.id}.txt`, renderDigestText(d, {
    unsubscribeUrl: `https://example.invalid/unsubscribe?u=${u.id}`,
    feedbackBaseUrl: 'https://example.invalid/feedback', userEmail: u.email }));

  console.log(`[digest] ${u.email}: pool=${pool.length} kept=${d.totalAfterFilter} ` +
    `authors=${d.authorPapers.length} shown=${shown.length} -> out/digest-${u.id}.html`);
  console.log(`         subject: ${renderSubject(d)}`);

  if (!DRY) {
    const key = process.env.RESEND_API_KEY;
    if (!key) { console.error('[digest] FATAL: RESEND_API_KEY unset but DRY_RUN=false'); process.exit(1); }
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        from: process.env.MAIL_FROM, to: u.email, subject: renderSubject(d), html,
        headers: {
          'List-Unsubscribe': `<https://example.invalid/unsubscribe?u=${u.id}>`,
          'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
        },
      }),
    });
    if (!r.ok) { console.error(`[digest] send failed ${r.status}: ${await r.text()}`); process.exit(1); }
    markSeen(u.id, shown.map((s) => s.paper.pmid));
  }
}
console.log(DRY ? '[digest] DRY RUN — nothing sent' : '[digest] sent');
