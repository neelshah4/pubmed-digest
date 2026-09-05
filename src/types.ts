// Shared contracts. Every module codes against these. Do not change without updating all callers.

/** One PubMed record, normalised. Produced ONLY by sources/parse.ts from real EFetch XML. */
export interface Paper {
  pmid: string;
  title: string;
  abstract: string;            // "" when PubMed has none
  journal: string;             // ISOAbbreviation, e.g. "Pediatr Crit Care Med"
  pubTypes: string[];          // e.g. ["Journal Article","Randomized Controlled Trial"]
  mesh: string[];              // descriptor names, e.g. ["Sepsis","Child"]
  meshMajor: string[];         // subset flagged MajorTopicYN="Y"
  authors: Author[];
  edat: string;                // Entrez date  YYYY-MM-DD
  pubdate: string;             // publication date YYYY-MM-DD (may be partial -> YYYY-MM-01)
  doi?: string;
  language: string[];
}

export interface Author {
  last: string;
  fore: string;
  orcid?: string;              // bare digits-with-dashes, no URL prefix
  affiliation?: string;
}

/** Output of score/detect.ts — every boolean is evidence for a boost or a filter. */
export interface Signals {
  pediatric: boolean;
  ecmo: boolean;
  pardsOrMechVent: boolean;
  societyGuideline: boolean;
  informaticsAi: boolean;
  hemodynamicMonitoring: boolean;
  eit: boolean;
  covidOnly: boolean;
  surgicalTechnique: boolean;
  epiOnly: boolean;
  isProtocol: boolean;
  ccRelevant: boolean;         // the Tier-3 gate
  sampleSize: number | null;
  matched: Record<string, string[]>;  // rule -> terms that fired. Audit trail.
}

export interface ScoredPaper {
  paper: Paper;
  signals: Signals;
  tier: 1 | 2 | 3 | null;
  section: string;             // ECMO | Respiratory_ARDS | ... | Misc
  base: number;
  score: number;
  boosts: Record<string, number>;
  practiceChanging: boolean;
  /** Set when the paper arrived via a followed author rather than the journal sweep. */
  authorMatch?: { orcid: string; label?: string };
}

export type Verdict =
  | { keep: true }
  | { keep: false; rule: string; detail: string };

/** Per-user config = the pubmed-watcher config shape. Loaded from a template + user overrides. */
export interface WatcherConfig {
  journals: {
    tier_1_primary_cc: string[];
    tier_2_top_general_plus_adjacent: string[];
    tier_3_cc_relevance_gate: string[];
  };
  tier_3_cc_relevance_gate_criteria: {
    mesh_terms_any_of: string[];
    title_abstract_any_of: string[];
  };
  publication_types: {
    include_any_of: string[];
    hard_exclude: string[];
    soft_exclude_unless_tier_1_or_2: string[];
  };
  filters: Record<string, unknown>;
  scoring: {
    weights: { journal_tier: number; study_type: number; preference_match: number; sample_size: number };
    journal_tier_score: Record<string, number>;
    study_type_score: Record<string, number>;
    per_journal_score_override: Record<string, number>;
    topic_boosts: Record<string, any>;
  };
  digest: {
    hard_cap: number;
    per_section_max: number;
    max_non_primary_per_digest: number;
    [k: string]: unknown;
  };
  preference_profile: {
    seed_examples: { pmid: string; topic: string; note?: string }[];
    learned_profile: LearnedProfile;
  };
  sections: Record<string, { mesh_terms: string[]; title_abstract_terms: string[] }>;
}

export interface LearnedProfile {
  gold_seed_distribution: {
    protected: boolean;
    positive_mesh_distribution: Record<string, number>;
    positive_ngrams: Record<string, number>;
    [k: string]: unknown;
  };
  positive_mesh_distribution: Record<string, number>;
  negative_mesh_distribution: Record<string, number>;
  positive_ngrams: Record<string, number>;
  negative_ngrams: Record<string, number>;
  last_updated?: string;
  history_window_weeks?: number;
  [k: string]: unknown;
}


/** An author the user follows. ORCID only — PubMed name matching is too noisy to ship. */
export interface AuthorWatch {
  orcid: string;            // bare 0000-0000-0000-000X
  label?: string;           // display name, user-supplied, never trusted for matching
}

/** Exactly what the signup form collects. The pipeline must honour every field. */
export interface SignupPrefs {
  email: string;
  cadence: 'weekly' | 'monthly';
  templates: string[];
  journalTier: 'tier1' | 'tier12' | 'all';
  pubTypes: string[];           // [] = no publication-type restriction
  extraKeywords: string[];      // free text, OR-ed, boosts and admits
  authors: AuthorWatch[];
}

export interface User {
  id: string;
  email: string;
  templates: string[];
  cadence: 'weekly' | 'monthly';
  llmTier: boolean;
  overrides?: Partial<WatcherConfig>;
  prefs?: SignupPrefs;
  verifiedAt?: string;          // double opt-in: unset means never send
  unsubToken?: string;
}

export interface Digest {
  userId: string;
  email?: string;
  generatedAt: string;
  windowDays: number;
  sections: { name: string; papers: ScoredPaper[] }[];
  practiceChanging: ScoredPaper[];
  borderline: ScoredPaper[];
  totalCandidates: number;
  totalAfterFilter: number;
  /** Papers surfaced because a followed author wrote them. */
  authorPapers: ScoredPaper[];
}
