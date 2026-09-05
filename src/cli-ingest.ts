/**
 * Daily ingest: journal union pull + followed-author pull -> parse -> upsert.
 * Fails loudly; an empty result is never treated as success.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { loadTemplate, allJournals } from './config.ts';
import { harvest, fetchPapers, searchAuthors } from './sources/eutils.ts';
import { upsertPapers, loadUsers } from './store.ts';

const days = Number(process.env.DAYS ?? process.argv[2] ?? 7);
const common = {
  days,
  retmax: Number(process.env.RETMAX ?? 3000),
  apiKey: process.env.NCBI_API_KEY,
  tool: 'pubmed-digest',
  email: process.env.NCBI_EMAIL,
};

// --- 1. journal union across every template any subscriber uses --------------
const users = await loadUsers();
const slugs = [...new Set(users.flatMap((u) => u.templates ?? []).concat('peds-cc'))];
const journals = [...new Set(slugs.flatMap((s) => {
  try { return allJournals(loadTemplate(s)); } catch { return []; }
}))];

console.log(`[ingest] ${journals.length} journals from ${slugs.length} template(s), last ${days}d`);
const t0 = Date.now();
const papers = await harvest({ ...common, journals });

if (papers.length === 0) {
  console.error('[ingest] FATAL: zero papers from the journal sweep. Refusing to call this success.');
  process.exit(1);
}

// --- 2. followed authors -----------------------------------------------------
// These bypass the journal whitelist downstream: you follow a person, not a venue.
const watched = [...new Set(users.flatMap((u) => (u.prefs?.authors ?? []).map((a) => a.orcid)))];
const authorHits: Record<string, { orcid: string; label?: string }> = {};
let authorPapers: typeof papers = [];

if (watched.length) {
  const { byOrcid, failed } = await searchAuthors(watched, common);
  const labelOf = new Map(
    users.flatMap((u) => (u.prefs?.authors ?? []).map((a) => [a.orcid, a.label] as const)),
  );
  const known = new Set(papers.map((p) => p.pmid));
  const missing: string[] = [];
  for (const [orcid, pmids] of byOrcid) {
    for (const pmid of pmids) {
      authorHits[pmid] = { orcid, label: labelOf.get(orcid) };
      if (!known.has(pmid)) missing.push(pmid);
    }
  }
  if (missing.length) authorPapers = await fetchPapers([...new Set(missing)], common);
  console.log(`[ingest] authors: ${watched.length} watched, ${Object.keys(authorHits).length} hits, ` +
              `${authorPapers.length} not already in the journal sweep` +
              (failed.length ? `, ${failed.length} failed (${failed.map((f) => f.orcid).join(', ')})` : ''));
}

const { added, total } = await upsertPapers([...papers, ...authorPapers]);
mkdirSync('data', { recursive: true });
writeFileSync('data/author-hits.json', JSON.stringify(authorHits, null, 2));
console.log(`[ingest] fetched=${papers.length + authorPapers.length} new=${added} cached=${total} in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
