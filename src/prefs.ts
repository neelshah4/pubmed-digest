/**
 * Turns what the signup form collects into a WatcherConfig.
 *
 * Before this existed the pipeline read only `templates[0]` and silently ignored
 * journal tier, publication types, keywords and followed authors — every other
 * choice on the form was decorative.
 */
import type { SignupPrefs, WatcherConfig, Paper } from './types.ts';
import { loadTemplate, withOverrides } from './config.ts';
import { hit } from './score/detect.ts';

/**
 * Publication-type choices, mapped to the strings PubMed actually uses.
 *
 * Keyed by every value the signup form has ever emitted. The form sends
 * kebab-case labels ("meta-analysis-systematic-review") while this module was
 * originally written against short slugs ("meta"), so two of the four choices
 * fell through an `?? [key]` fallback and became literal strings that match no
 * publication type — ticking "Meta-Analysis" silently produced an empty digest.
 * Both spellings are accepted, and unrecognised keys are now reported rather
 * than passed through.
 */
const PT_GROUPS: Record<string, string[]> = {
  rct: ['Randomized Controlled Trial', 'Clinical Trial', 'Controlled Clinical Trial'],
  meta: ['Meta-Analysis', 'Systematic Review'],
  'meta-analysis': ['Meta-Analysis', 'Systematic Review'],
  'meta-analysis-systematic-review': ['Meta-Analysis', 'Systematic Review'],
  'systematic-review': ['Meta-Analysis', 'Systematic Review'],
  observational: ['Observational Study', 'Multicenter Study', 'Comparative Study', 'Journal Article'],
  guideline: ['Practice Guideline', 'Guideline', 'Consensus Development Conference'],
  'practice-guideline': ['Practice Guideline', 'Guideline', 'Consensus Development Conference'],
};

/** A real PubMed publication type, e.g. "Randomized Controlled Trial". */
const looksLikeRawPubType = (k: string) => /[A-Z]/.test(k) && /\s/.test(k);

/**
 * Expands the form's choices into PubMed publication types.
 * Unknown keys are dropped, not passed through: a key that matches no real type
 * would turn the restriction into "nothing qualifies" and empty the digest.
 */
export function expandPubTypes(keys: string[]): string[] {
  return [...new Set(keys.flatMap((k) => PT_GROUPS[k] ?? (looksLikeRawPubType(k) ? [k] : [])))];
}

/** Keys the form sent that this module does not recognise. Surface, do not ignore. */
export function unknownPubTypes(keys: string[]): string[] {
  return keys.filter((k) => !PT_GROUPS[k] && !looksLikeRawPubType(k));
}

/** Merge every template the user subscribed to, then apply their narrowing choices. */
export function configFor(prefs: SignupPrefs): WatcherConfig {
  const slugs = prefs.templates.length ? prefs.templates : ['peds-cc'];
  let cfg = loadTemplate(slugs[0]);

  // Additional templates widen the journal set and the section list; they never
  // narrow, because subscribing to more topics should not lose you coverage.
  for (const s of slugs.slice(1)) {
    const t = loadTemplate(s);
    cfg = withOverrides(cfg, {
      journals: {
        tier_1_primary_cc: [...new Set([...cfg.journals.tier_1_primary_cc, ...t.journals.tier_1_primary_cc])],
        tier_2_top_general_plus_adjacent: [...new Set([...cfg.journals.tier_2_top_general_plus_adjacent, ...t.journals.tier_2_top_general_plus_adjacent])],
        tier_3_cc_relevance_gate: [...new Set([...cfg.journals.tier_3_cc_relevance_gate, ...t.journals.tier_3_cc_relevance_gate])],
      },
      sections: { ...cfg.sections, ...t.sections },
    });
  }

  // Journal tier. Emptying a tier is what makes journalTier meaningful: the tier
  // lookup returns null for an unlisted journal, and the filter drops those.
  if (prefs.journalTier === 'tier1') {
    cfg = withOverrides(cfg, { journals: { ...cfg.journals, tier_2_top_general_plus_adjacent: [], tier_3_cc_relevance_gate: [] } });
  } else if (prefs.journalTier === 'tier12') {
    cfg = withOverrides(cfg, { journals: { ...cfg.journals, tier_3_cc_relevance_gate: [] } });
  }

  // Publication types. An empty selection means "no restriction", not "nothing".
  const pts = expandPubTypes(prefs.pubTypes ?? []);
  if (pts.length) {
    cfg = withOverrides(cfg, {
      publication_types: { ...cfg.publication_types, include_any_of: pts },
    });
  }

  return cfg;
}

/** True when the user's own keywords appear in the paper. Used to admit and to boost. */
export function matchesKeywords(p: Paper, prefs: SignupPrefs): string[] {
  const kws = (prefs.extraKeywords ?? []).map((k) => k.trim()).filter(Boolean);
  if (!kws.length) return [];
  const text = `${p.title}\n${p.abstract}`.toLowerCase();
  return kws.filter((k) => hit(text, k.toLowerCase()));
}

/** Restrict a paper set to the publication types the user asked for. */
export function passesPubTypeChoice(p: Paper, prefs: SignupPrefs): boolean {
  const pts = expandPubTypes(prefs.pubTypes ?? []);
  if (!pts.length) return true;
  return p.pubTypes.some((t) => pts.includes(t));
}

export const DEFAULT_PREFS: SignupPrefs = {
  email: '', cadence: 'weekly', templates: ['peds-cc'],
  journalTier: 'all', pubTypes: [], extraKeywords: [], authors: [],
};
