/**
 * preference_match without a model: sparse cosine over MeSH + abstract n-grams.
 *
 * Two invariants the legacy config learned the hard way and this port preserves:
 *   1. gold_seed_distribution is a PROTECTED FLOOR — re-unioned on every run.
 *   2. A run with no new tags must NEVER blank positive_* back to {}.
 */
import type { Paper, LearnedProfile } from '../types.ts';

export type Vec = Record<string, number>;

const STOP = new Set(['the','and','for','with','was','were','that','this','from','are','has','have',
  'not','but','all','can','who','had','его','than','then','they','their','been','after','before',
  'during','between','among','into','over','under','more','less','study','patients','results',
  'methods','conclusions','background','objective','objectives','using','used','compared','associated']);

export function ngrams(p: Paper, n = 2): Vec {
  const words = `${p.title} ${p.abstract}`.toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ').split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w));
  const v: Vec = {};
  for (const w of words) v[w] = (v[w] ?? 0) + 1;
  for (let i = 0; i + n - 1 < words.length; i++) {
    const g = words.slice(i, i + n).join(' ');
    v[g] = (v[g] ?? 0) + 1;
  }
  return v;
}

export function paperVec(p: Paper): Vec {
  const v = ngrams(p);
  for (const m of p.mesh) v[`mesh:${m.toLowerCase()}`] = (v[`mesh:${m.toLowerCase()}`] ?? 0) + 3;
  for (const m of p.meshMajor) v[`mesh:${m.toLowerCase()}`] = (v[`mesh:${m.toLowerCase()}`] ?? 0) + 2;
  return v;
}

export function cosine(a: Vec, b: Vec): number {
  let dot = 0, na = 0, nb = 0;
  for (const k in a) { na += a[k] * a[k]; if (k in b) dot += a[k] * b[k]; }
  for (const k in b) nb += b[k] * b[k];
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

/** Merge the protected gold floor into the live positive distribution. Never destructive. */
export function positiveVec(lp: LearnedProfile): Vec {
  const out: Vec = {};
  const add = (src: Record<string, number> | undefined, scale = 1) => {
    for (const [k, v] of Object.entries(src ?? {})) out[k] = (out[k] ?? 0) + v * scale;
  };
  const gold = lp.gold_seed_distribution ?? ({} as any);
  add(gold.positive_ngrams);
  for (const [k, v] of Object.entries(gold.positive_mesh_distribution ?? {})) {
    out[`mesh:${k.toLowerCase()}`] = (out[`mesh:${k.toLowerCase()}`] ?? 0) + v;
  }
  add(lp.positive_ngrams);
  for (const [k, v] of Object.entries(lp.positive_mesh_distribution ?? {})) {
    out[`mesh:${k.toLowerCase()}`] = (out[`mesh:${k.toLowerCase()}`] ?? 0) + v;
  }
  return out;
}

export function negativeVec(lp: LearnedProfile): Vec {
  const out: Vec = {};
  for (const [k, v] of Object.entries(lp.negative_ngrams ?? {})) out[k] = v;
  for (const [k, v] of Object.entries(lp.negative_mesh_distribution ?? {})) {
    out[`mesh:${k.toLowerCase()}`] = (out[`mesh:${k.toLowerCase()}`] ?? 0) + v;
  }
  return out;
}

/** preference_match = cos(cand,pos) - 0.5*cos(cand,neg), clamped to [0,1]. */
export function preferenceMatch(p: Paper, lp: LearnedProfile): number {
  const v = paperVec(p);
  const s = cosine(v, positiveVec(lp)) - 0.5 * cosine(v, negativeVec(lp));
  return Math.max(0, Math.min(1, s));
}

/** Apply feedback tags. Decays existing weight, then adds. Gold floor is untouched. */
export function applyFeedback(
  lp: LearnedProfile,
  events: { paper: Paper; tag: 'star' | 'skip' | 'tilde' }[],
  decay = 0.9,
): LearnedProfile {
  const next: LearnedProfile = structuredClone(lp);
  const scaleAll = (o: Record<string, number> = {}) => {
    for (const k in o) o[k] *= decay;
    return o;
  };
  next.positive_ngrams = scaleAll(next.positive_ngrams ?? {});
  next.negative_ngrams = scaleAll(next.negative_ngrams ?? {});
  next.positive_mesh_distribution = scaleAll(next.positive_mesh_distribution ?? {});
  next.negative_mesh_distribution = scaleAll(next.negative_mesh_distribution ?? {});

  for (const { paper, tag } of events) {
    const w = tag === 'star' ? 1 : tag === 'tilde' ? 0.3 : 1;
    const ngT = tag === 'skip' ? next.negative_ngrams : next.positive_ngrams;
    const mhT = tag === 'skip' ? next.negative_mesh_distribution : next.positive_mesh_distribution;
    for (const [k, v] of Object.entries(ngrams(paper))) ngT[k] = (ngT[k] ?? 0) + v * w;
    for (const m of paper.mesh) mhT[m] = (mhT[m] ?? 0) + w;
  }
  next.last_updated = new Date().toISOString().slice(0, 10);
  // Invariant 2: never hand back empty positives.
  if (Object.keys(next.positive_ngrams).length === 0) next.positive_ngrams = { ...(lp.positive_ngrams ?? {}) };
  return next;
}
