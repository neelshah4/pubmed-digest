/** Filter pipeline, in the order specified by pubmed-watcher.md lines 89-110. */
import type { Paper, Signals, Verdict, WatcherConfig } from '../types.ts';
import { journalTier } from '../config.ts';

const GUIDELINE_PT = ['Practice Guideline', 'Guideline'];
/** Tier-1/2 journals whose scope is all of medicine, not critical care. */
const GENERAL_SCOPE = new Set([
  'Cochrane Database Syst Rev', 'N Engl J Med', 'JAMA', 'Lancet', 'BMJ', 'Nat Med',
  'JAMA Intern Med', 'JAMA Pediatr', 'Ann Intern Med', 'JAMA Netw Open',
]);

const NON_PRIMARY_PT = ['Editorial', 'Letter', 'Case Reports', 'Review', 'Comment'];

export function isNonPrimary(p: Paper): boolean {
  return p.pubTypes.some((t) => NON_PRIMARY_PT.includes(t));
}

export function filterPaper(p: Paper, s: Signals, cfg: WatcherConfig): Verdict {
  const tier = journalTier(cfg, p.journal);
  const pt = cfg.publication_types;

  // 1. hard PT exclude (re-checked post-retrieval; PubMed indexing lags)
  const hard = p.pubTypes.filter((t) => pt.hard_exclude.includes(t));
  if (hard.length) return { keep: false, rule: 'hard_pt_exclude', detail: hard.join(', ') };

  // 6. language (cheap, hoisted)
  if (p.language.length && !p.language.includes('eng')) {
    return { keep: false, rule: 'language', detail: p.language.join(',') };
  }

  const isGuideline = p.pubTypes.some((t) => GUIDELINE_PT.includes(t));
  const isCochrane = /cochrane/i.test(p.journal);

  // 2. suppression rules
  if (s.covidOnly && !isGuideline && !isCochrane) {
    return { keep: false, rule: 'suppress_covid_only', detail: (s.matched.covid_only ?? []).join(', ') };
  }
  if (s.surgicalTechnique) {
    return { keep: false, rule: 'suppress_surgical_technique', detail: (s.matched.surgical_technique ?? []).join(', ') };
  }
  if (s.epiOnly) {
    return { keep: false, rule: 'suppress_epi_only', detail: (s.matched.epi_only ?? []).join(', ') };
  }

  // 4. protocols / trial registrations
  if (s.isProtocol) {
    return { keep: false, rule: 'protocol', detail: (s.matched.protocol ?? []).join(', ') };
  }

  // 3. soft excludes and gated non-primary admits
  const soft = p.pubTypes.filter((t) => pt.soft_exclude_unless_tier_1_or_2.includes(t));
  if (soft.length && !(tier === 1 || tier === 2)) {
    return { keep: false, rule: 'soft_exclude_non_tier12', detail: soft.join(', ') };
  }
  const isEdLetter = p.pubTypes.some((t) => t === 'Editorial' || t === 'Letter');
  if (isEdLetter) {
    if (!(tier === 1 || tier === 2)) {
      return { keep: false, rule: 'editorial_letter_non_tier12', detail: p.pubTypes.join(', ') };
    }
    if (!s.ccRelevant) {
      return { keep: false, rule: 'editorial_letter_failed_cc_gate', detail: 'no CC relevance evidence' };
    }
  }

  // 5. CC-relevance gate.
  // The legacy written rule gates Tier 3 only. That silently assumes every Tier-1/2
  // journal is CC-scoped, which is false: Cochrane, NEJM, JAMA, Lancet, BMJ and
  // Nat Med publish across all of medicine, so a Cochrane low-back-pain review
  // passed straight into a critical-care digest. The legacy LLM applied this gate
  // by judgment; encoding it is a deliberate, documented deviation from the prose.
  if ((tier === 3 || GENERAL_SCOPE.has(p.journal)) && !s.ccRelevant) {
    return { keep: false, rule: 'cc_relevance_gate', detail: `${p.journal}: no CC relevance evidence` };
  }
  if (tier === null) {
    return { keep: false, rule: 'journal_not_in_whitelist', detail: p.journal };
  }

  return { keep: true };
}
