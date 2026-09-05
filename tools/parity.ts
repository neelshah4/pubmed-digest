/**
 * Parity harness: does the ported scorer agree with the legacy LLM-driven agent?
 *
 * Reads an archived digest, re-fetches its PMIDs live from PubMed, re-scores
 * them, and reports retention, section agreement, and rank correlation. This is
 * the gate that says whether the port is faithful; it is not a unit test because
 * it needs the network.
 *
 *   node --experimental-strip-types tools/parity.ts ~/.claude/digests/pubmed-2026-05-18.md
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { loadTemplate } from '../src/config.ts';
import { fetchPapers } from '../src/sources/eutils.ts';
import { scorePaper, assignSection } from '../src/score/score.ts';
import { detect } from '../src/score/detect.ts';
import { filterPaper } from '../src/score/filter.ts';

interface Entry { pmid: string; title: string; section: string; tag: string; order: number }

/** Parse the archived markdown: `## Section`, `### Title`, a pubmed link, `- **Tag:** [x]`. */
export function parseDigest(md: string): Entry[] {
  const out: Entry[] = [];
  let section = 'Unknown';
  let title = '';
  let pmid = '';
  let order = 0;
  const flush = (tag: string) => {
    if (pmid) out.push({ pmid, title, section, tag, order: order++ });
    pmid = ''; title = '';
  };
  for (const line of md.split('\n')) {
    const sec = line.match(/^##\s+(.+?)\s*$/);
    const ttl = line.match(/^###\s+(.+?)\s*$/);
    const pm = line.match(/pubmed\.ncbi\.nlm\.nih\.gov\/(\d+)/);
    const tg = line.match(/\*\*Tag:\*\*\s*\[([^\]]*)\]/);
    if (sec && !sec[1].startsWith('#')) { if (pmid) flush(''); section = sec[1].trim(); }
    else if (ttl) { if (pmid) flush(''); title = ttl[1].trim(); }
    else if (pm) pmid = pm[1];
    else if (tg) flush(tg[1].trim());
  }
  if (pmid) flush('');
  return out;
}

const SECTION_ALIAS: Record<string, string> = {
  'ECMO': 'ECMO',
  'Respiratory & ARDS': 'Respiratory_ARDS',
  'Shock & Sepsis': 'Shock_Sepsis',
  'Neurocritical Care': 'Neurocritical_Care',
  'Cardiac Critical Care': 'Cardiac_CC',
  'Renal': 'Renal',
  'Misc': 'Misc',
  'Practice-changing this week': '*',      // pinned, section-agnostic
  'Borderline (worth a peek)': '*',
};

/** Retained for reference; see the Gate 3 note on why order-parity is not used. */
function spearman(a: number[], b: number[]): number {
  const n = a.length;
  if (n < 3) return NaN;
  const rank = (xs: number[]) => {
    const idx = xs.map((v, i) => [v, i] as const).sort((p, q) => p[0] - q[0]);
    const r = new Array(n).fill(0);
    idx.forEach(([, i], k) => { r[i] = k + 1; });
    return r;
  };
  const ra = rank(a), rb = rank(b);
  const d2 = ra.reduce((s, v, i) => s + (v - rb[i]) ** 2, 0);
  return 1 - (6 * d2) / (n * (n * n - 1));
}

const file = process.argv[2] ?? `${homedir()}/.claude/digests/pubmed-2026-05-18.md`;
const entries = parseDigest(readFileSync(file, 'utf8'));
console.log(`fixture: ${file.replace(homedir(), '~')}`);
console.log(`entries parsed: ${entries.length}  (★ ${entries.filter(e => e.tag === '★').length}, ` +
            `skip ${entries.filter(e => e.tag === 'skip').length})\n`);
if (!entries.length) { console.error('FAIL: parsed nothing — the fixture format changed.'); process.exit(1); }

const cfg = loadTemplate('peds-cc');
const papers = await fetchPapers(entries.map(e => e.pmid), {
  email: process.env.NCBI_EMAIL, apiKey: process.env.NCBI_API_KEY, days: 0,
});
const byPmid = new Map(papers.map(p => [p.pmid, p]));
console.log(`re-fetched from PubMed: ${papers.length}/${entries.length}\n`);

// --- Gate 1: retention -------------------------------------------------------
let kept = 0; const dropped: string[] = [];
for (const e of entries) {
  const p = byPmid.get(e.pmid);
  if (!p) { dropped.push(`${e.pmid} NOT FETCHED`); continue; }
  const sig = detect(p, cfg);
  const v = filterPaper(p, sig, cfg);
  if (v.keep) kept++;
  else dropped.push(`${e.pmid} [${e.tag || '-'}] ${v.rule}: ${v.detail.slice(0, 60)} — ${p.title.slice(0, 54)}`);
}
const retention = kept / entries.length;
console.log(`GATE 1 retention: ${kept}/${entries.length} = ${(retention * 100).toFixed(1)}%  ` +
            `${retention >= 0.95 ? 'PASS' : 'FAIL (target >=95%)'}`);
if (dropped.length) { console.log('  dropped:'); for (const d of dropped) console.log('   -', d); }

// --- Gate 2: section agreement ----------------------------------------------
let agree = 0, comparable = 0; const mismatches: string[] = [];
for (const e of entries) {
  const p = byPmid.get(e.pmid); if (!p) continue;
  const want = SECTION_ALIAS[e.section]; if (!want || want === '*') continue;
  comparable++;
  const got = assignSection(p, detect(p, cfg), cfg);
  if (got === want) agree++;
  else mismatches.push(`${e.pmid} want=${want} got=${got} — ${p.title.slice(0, 52)}`);
}
console.log(`\nGATE 2 section agreement: ${agree}/${comparable} = ` +
            `${comparable ? (100 * agree / comparable).toFixed(1) : 'n/a'}%`);
for (const m of mismatches) console.log('   -', m);

// --- Gate 3: rank correlation + starred papers ------------------------------
const scoredPairs = entries
  .map(e => ({ e, sp: byPmid.get(e.pmid) ? scorePaper(byPmid.get(e.pmid)!, cfg, { bypassJournalGate: true }) : null }))
  .filter((x): x is { e: Entry; sp: NonNullable<ReturnType<typeof scorePaper>> } => x.sp !== null);

// Rank parity against the archive's ORDER is not measurable: the archived digest
// is grouped by section, not sorted by score, so position encodes topic rather
// than preference. What is measurable, and what actually matters, is whether the
// score separates the papers Neel starred from the ones he skipped.
const ranked = [...scoredPairs].sort((a, b) => b.sp.score - a.sp.score);
const starred = scoredPairs.filter(x => x.e.tag === '★');
const skipped = scoredPairs.filter(x => x.e.tag === 'skip');

const starredInTop25 = starred.filter(x => ranked.indexOf(x) < 25).length;
console.log(`\nGATE 3 preference separation`);
console.log(`  ★ inside the top 25 by new score: ${starredInTop25}/${starred.length} ` +
            `${starredInTop25 === starred.length ? 'PASS' : 'FAIL'}`);

if (starred.length && skipped.length) {
  // AUC: over every (starred, skipped) pair, how often does the starred paper win?
  let wins = 0, ties = 0;
  for (const a of starred) for (const b of skipped) {
    if (a.sp.score > b.sp.score) wins++; else if (a.sp.score === b.sp.score) ties++;
  }
  const pairs = starred.length * skipped.length;
  const auc = (wins + 0.5 * ties) / pairs;
  const meanStar = starred.reduce((s, x) => s + x.sp.score, 0) / starred.length;
  const meanSkip = skipped.reduce((s, x) => s + x.sp.score, 0) / skipped.length;
  console.log(`  AUC ★ over skip: ${auc.toFixed(3)} across ${pairs} pairs  ` +
              `${auc >= 0.75 ? 'PASS' : 'BELOW TARGET (0.75)'}`);
  console.log(`  mean score  ★ ${meanStar.toFixed(3)}  vs  skip ${meanSkip.toFixed(3)}  ` +
              `${meanStar > meanSkip ? 'correct ordering' : 'INVERTED'}`);
} else {
  console.log('  not enough tagged papers to measure separation');
}
