/** Daily ingest: union pull -> parse -> upsert. Fails loudly; never silently empty. */
import { loadTemplate, allJournals } from './config.ts';
import { harvest } from './sources/eutils.ts';
import { upsertPapers } from './state.ts';

const days = Number(process.env.DAYS ?? process.argv[2] ?? 7);
const cfg = loadTemplate('peds-cc');
const journals = allJournals(cfg);

console.log(`[ingest] ${journals.length} journals, last ${days}d`);
const t0 = Date.now();
const papers = await harvest({
  journals, days,
  apiKey: process.env.NCBI_API_KEY,
  retmax: Number(process.env.RETMAX ?? 3000),
  tool: 'pubmed-digest',
  email: process.env.NCBI_EMAIL ?? 'neels31@gmail.com',
});

if (papers.length === 0) {
  console.error('[ingest] FATAL: zero papers returned. Refusing to treat this as success.');
  process.exit(1);
}
const { added, total } = upsertPapers(papers);
console.log(`[ingest] fetched=${papers.length} new=${added} cached=${total} in ${((Date.now()-t0)/1000).toFixed(1)}s`);
