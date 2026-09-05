/** Scoring formula, section assignment, and digest assembly (pubmed-watcher.md 111-151). */
import type { Paper, ScoredPaper, Signals, WatcherConfig, Digest, SignupPrefs } from '../types.ts';
import { journalTier } from '../config.ts';
import { detect, hit } from './detect.ts';
import { filterPaper, isNonPrimary } from './filter.ts';
import { matchesKeywords, passesPubTypeChoice } from '../prefs.ts';
import { preferenceMatch } from './profile.ts';

const TIER_SCORE: Record<number, number> = { 1: 1.0, 2: 0.8, 3: 0.5 };

/** Highest-value PT wins. Falls back to plain Journal Article = 0.60. */
export function studyTypeScore(p: Paper, cfg: WatcherConfig): number {
  const tbl = cfg.scoring.study_type_score ?? {};
  const map: [string, number][] = [
    ['Randomized Controlled Trial', 1.0], ['Practice Guideline', 1.0], ['Guideline', 1.0],
    ['Meta-Analysis', 0.9], ['Systematic Review', 0.9],
    ['Multicenter Study', 0.8], ['Observational Study', 0.8], ['Clinical Trial', 0.8],
    ['Validation Study', 0.5], ['Review', 0.5], ['Letter', 0.35],
    ['Editorial', 0.30], ['Case Reports', 0.30],
  ];
  let best = 0;
  for (const [pt, fallback] of map) {
    if (p.pubTypes.includes(pt)) best = Math.max(best, tbl[pt] ?? fallback);
  }
  return best || (tbl['Journal Article'] ?? 0.60);
}

export function sampleSizeScore(n: number | null, pediatric: boolean): number {
  if (n === null) return pediatric ? 0.4 : 0.3;
  const raw = Math.log10(Math.max(n, 10)) / 5;
  const clamped = Math.max(0, Math.min(1, raw));
  return pediatric ? Math.max(0.4, clamped) : clamped;
}

/**
 * Section assignment. Weights are deliberate: a paper's TITLE states its topic,
 * whereas MeSH indexing is generous (a PICU catheter study carries
 * "Respiration, Artificial" simply because the patients were ventilated).
 * Title 3 > MeSH 2 > abstract 1, so a "Sepsis" title beats an incidental
 * respiratory MeSH tag instead of losing a tie on config key order.
 */
export function assignSection(p: Paper, s: Signals, cfg: WatcherConfig): string {
  const title = p.title.toLowerCase();
  const abs = (p.abstract ?? '').toLowerCase();
  const ms = new Set(p.mesh.map((m) => m.toLowerCase()));
  const major = new Set(p.meshMajor.map((m) => m.toLowerCase()));
  let bestName = 'Misc', bestHits = 0;
  for (const [name, def] of Object.entries(cfg.sections ?? {})) {
    let hits = 0;
    for (const m of def.mesh_terms ?? []) {
      const k = m.toLowerCase();
      // 73.4% of a live 7-day pull had no MeSH, so the descriptor name is also
      // matched as text — otherwise a paper titled "...Sepsis..." scores zero
      // for Shock_Sepsis purely because NLM has not indexed it yet.
      const asText = k.replace(/,.*$/, '');
      if (major.has(k)) hits += 3;
      else if (ms.has(k)) hits += 2;
      else if (hit(title, asText)) hits += 3;
      else if (hit(abs, asText)) hits += 1;
    }
    // Word-boundary, not substring: `includes('aki')` matched "taking",
    // `includes('ich')` matched "which", which mis-sectioned most of the digest.
    for (const t of def.title_abstract_terms ?? []) {
      if (hit(title, t)) hits += 3; else if (hit(abs, t)) hits += 1;
    }
    if (hits > bestHits) { bestHits = hits; bestName = name; }
  }
  return bestHits > 0 ? bestName : 'Misc';
}

export function scorePaper(
  p: Paper,
  cfg: WatcherConfig,
  opts: { bypassJournalGate?: boolean } = {},
): ScoredPaper | null {
  const signals = detect(p, cfg);
  if (!opts.bypassJournalGate) {
    const verdict = filterPaper(p, signals, cfg);
    if (!verdict.keep) return null;
  }
  // A followed author's paper is wanted wherever it appears, so an unlisted
  // journal scores as Tier 3 rather than disqualifying the paper.
  const tier = journalTier(cfg, p.journal) ?? 3;
  const w = cfg.scoring.weights;
  const pref = preferenceMatch(p, cfg.preference_profile.learned_profile);

  const base =
    w.journal_tier * (TIER_SCORE[tier] ?? 0.5) +
    w.study_type * studyTypeScore(p, cfg) +
    w.preference_match * pref +
    w.sample_size * sampleSizeScore(signals.sampleSize, signals.pediatric);

  const tb: any = cfg.scoring.topic_boosts ?? {};
  const boosts: Record<string, number> = {
    journal_override: cfg.scoring.per_journal_score_override?.[p.journal] ?? 1.0,
    pediatric: signals.pediatric ? (tb.pediatric ?? 1.5) : 1,
    ecmo: signals.ecmo ? (tb.ecmo ?? 1.3) : 1,
    pards_or_mech_vent: signals.pardsOrMechVent ? (tb.pards_or_mech_vent ?? 1.3) : 1,
    society_guideline: signals.societyGuideline ? (tb.society_guideline?.boost ?? 1.4) : 1,
    informatics_ai: signals.informaticsAi ? (tb.informatics_ai_in_cc?.boost ?? 1.25) : 1,
    hemodynamic: signals.hemodynamicMonitoring ? (tb.hemodynamic_perfusion_monitoring?.boost ?? 1.2) : 1,
    eit: signals.eit ? (tb.eit_regional_ventilation?.boost ?? 1.3) : 1,
  };
  const score = Object.values(boosts).reduce((a, b) => a * b, base);

  const practiceChanging =
    (p.pubTypes.some((t) => t === 'Practice Guideline' || t === 'Guideline') && signals.ccRelevant) ||
    (p.pubTypes.includes('Randomized Controlled Trial') && (signals.sampleSize ?? 0) >= 100 && tier <= 2);

  return { paper: p, signals, tier, section: assignSection(p, signals, cfg), base, score, boosts, practiceChanging };
}

export function buildDigest(
  papers: Paper[],
  cfg: WatcherConfig,
  userId: string,
  windowDays: number,
  opts: {
    prefs?: SignupPrefs;
    /** pmid -> the followed author who wrote it */
    authorHits?: Map<string, { orcid: string; label?: string }>;
    email?: string;
  } = {},
): Digest {
  const { prefs, authorHits = new Map() } = opts;

  const scored: ScoredPaper[] = [];
  const authorPapers: ScoredPaper[] = [];

  for (const p of papers) {
    const watched = authorHits.get(p.pmid);
    const sp = scorePaper(p, cfg, { bypassJournalGate: Boolean(watched) });
    if (!sp) continue;

    // The user's own keywords both admit and lift a paper.
    if (prefs) {
      const kw = matchesKeywords(p, prefs);
      if (kw.length) {
        sp.boosts.keyword = 1.25;
        sp.score *= 1.25;
        sp.signals.matched.user_keywords = kw;
      }
      // A publication-type choice is a restriction the user asked for, but it
      // must never hide a paper by an author they explicitly follow.
      if (!watched && !passesPubTypeChoice(p, prefs)) continue;
    }

    if (watched) {
      sp.authorMatch = watched;
      authorPapers.push(sp);
    } else {
      scored.push(sp);
    }
  }

  scored.sort((a, b) => b.score - a.score);
  authorPapers.sort((a, b) => b.score - a.score);

  const cap = cfg.digest.hard_cap ?? 25;
  const perSecMax = cfg.digest.per_section_max ?? 5;
  const maxNonPrimary = cfg.digest.max_non_primary_per_digest ?? 4;

  const chosen: ScoredPaper[] = [];
  const perSec: Record<string, number> = {};
  const takenPmids = new Set(authorPapers.map((a) => a.paper.pmid));
  let nonPrimary = 0;
  for (const sp of scored) {
    if (chosen.length >= cap) break;
    if (takenPmids.has(sp.paper.pmid)) continue;   // already shown under its author
    if ((perSec[sp.section] ?? 0) >= perSecMax) continue;
    if (isNonPrimary(sp.paper)) { if (nonPrimary >= maxNonPrimary) continue; nonPrimary++; }
    chosen.push(sp);
    perSec[sp.section] = (perSec[sp.section] ?? 0) + 1;
  }

  const borderline = scored.filter((s) => !chosen.includes(s) && !takenPmids.has(s.paper.pmid)).slice(0, 3);

  // Only the top 3 practice-changing get pinned; the rest stay in their sections
  // rather than vanishing from both places.
  const pinned = new Set(chosen.filter((c) => c.practiceChanging).slice(0, 3));

  // 'Misc' is already a key in cfg.sections — appending it again duplicated
  // every Misc paper in the rendered digest.
  const order = [...new Set([...Object.keys(cfg.sections ?? {}), 'Misc'])];
  const sections = order
    .map((name) => ({ name, papers: chosen.filter((c) => c.section === name && !pinned.has(c)) }))
    .filter((s) => s.papers.length > 0);

  return {
    userId, email: opts.email, generatedAt: new Date().toISOString(), windowDays, sections,
    practiceChanging: [...pinned],
    borderline, totalCandidates: papers.length, totalAfterFilter: scored.length + authorPapers.length,
    authorPapers: authorPapers.slice(0, 10),
  };
}
