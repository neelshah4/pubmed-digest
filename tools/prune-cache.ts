/**
 * Trims data/papers.json to a rolling window.
 *
 * Only relevant while git is the store: the ingest workflow commits this file
 * every run, so an unbounded cache adds ~4 MB per day to repository history.
 * With Supabase configured the file is never committed and this is a no-op.
 *
 *   node --experimental-strip-types tools/prune-cache.ts [days=120]
 */
import { existsSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import type { Paper } from '../src/types.ts';

const days = Number(process.argv[2] ?? 120);
const path = 'data/papers.json';
if (!existsSync(path)) { console.log('[prune] no cache, nothing to do'); process.exit(0); }

const before = statSync(path).size;
const db = JSON.parse(readFileSync(path, 'utf8')) as Record<string, Paper>;
const cutoff = new Date(Date.now() - days * 864e5).toISOString().slice(0, 10);

const kept: Record<string, Paper> = {};
for (const [pmid, p] of Object.entries(db)) {
  // Keep anything without a usable date rather than silently discarding it.
  if (!p?.edat || p.edat >= cutoff) kept[pmid] = p;
}
writeFileSync(path, JSON.stringify(kept, null, 2));
const after = statSync(path).size;
console.log(`[prune] window=${days}d  ${Object.keys(db).length} -> ${Object.keys(kept).length} papers, ` +
            `${(before / 1e6).toFixed(1)} -> ${(after / 1e6).toFixed(1)} MB`);
