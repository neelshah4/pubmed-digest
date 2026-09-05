/**
 * Closes the gap between the pubmed-watcher config (which is ~80% explicit lists)
 * and the ~20% expressed as prose an LLM was expected to interpret.
 *
 * Every rule here is an explicit, auditable term list. `Signals.matched` records
 * which terms fired so a disagreement with the legacy agent can be adjudicated
 * instead of guessed at.
 */
import type { Paper, Signals, WatcherConfig } from '../types.ts';

const norm = (s: string) => s.toLowerCase();
const hay = (p: Paper) => norm(`${p.title}\n${p.abstract}`);
const meshSet = (p: Paper) => new Set(p.mesh.map(norm));

/** Word-boundary match; supports a trailing * for prefix matching. */
export function hit(text: string, term: string): boolean {
  const t = norm(term);
  if (t.endsWith('*')) {
    const stem = t.slice(0, -1).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`\\b${stem}`, 'i').test(text);
  }
  const esc = t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^a-z0-9])${esc}([^a-z0-9]|$)`, 'i').test(text);
}
const anyHit = (text: string, terms: string[]) => terms.filter((t) => hit(text, t));
const anyMesh = (ms: Set<string>, terms: string[]) => terms.filter((t) => ms.has(norm(t)));

/**
 * MeSH terms matched against the indexed headings OR the raw text.
 *
 * Measured on a live 7-day pull: 73.4% of papers carried NO MeSH at all, because
 * NLM indexing lags weeks behind publication. Any rule keyed only on MeSH is
 * therefore blind on precisely the recent papers this product exists to surface.
 * Matching the descriptor name as text recovers them. The config author already
 * knew this for the Tier-3 gate (which pairs mesh_terms_any_of with
 * title_abstract_any_of); this applies the same idea everywhere else.
 */
const anyMeshOrText = (ms: Set<string>, text: string, terms: string[]) =>
  terms.filter((t) => ms.has(norm(t)) || hit(text, norm(t).replace(/,.*$/, '')));

// ---------------------------------------------------------------------------
// Term lists authored to replace prose rules. Each cites the config rule it closes.
// ---------------------------------------------------------------------------

/** closes: "pediatric_boost: detected via MeSH ... or title/abstract pediatric population phrasing" */
const PEDIATRIC_MESH = ['Infant', 'Infant, Newborn', 'Child', 'Child, Preschool', 'Adolescent',
  'Pediatrics', 'Intensive Care Units, Pediatric', 'Intensive Care Units, Neonatal',
  'Intensive Care, Neonatal', 'Infant, Premature'];
const PEDIATRIC_TA = ['pediatric', 'paediatric', 'children', 'child', 'neonat*', 'infant*',
  'newborn', 'adolescent*', 'PICU', 'NICU', 'PCICU', 'preterm', 'premature infant',
  'school-age', 'young people', 'PARDS'];

/** closes: suppression_rules "COVID-only" */
const COVID_TA = ['covid-19', 'covid19', 'covid', 'sars-cov-2', 'sars cov 2', 'coronavirus disease 2019'];
const COVID_MESH = ['COVID-19', 'SARS-CoV-2', 'Coronavirus Infections'];

/** closes: suppression_rules "surgical-technique without CC outcomes" */
const SURGICAL_TA = ['surgical technique', 'operative technique', 'anastomosis', 'laparoscop*',
  'arthroplasty', 'fracture fixation', 'cholecystectomy', 'colorectal resection', 'hernia repair',
  'valve repair', 'valve replacement', 'graft patency', 'wound closure', 'suture technique',
  'endoscopic resection', 'robotic surgery', 'incision'];
/** an ICU/CC outcome rescues a surgical paper from suppression */
const CC_OUTCOME_TA = ['icu', 'intensive care', 'critical care', 'critically ill', 'mortality',
  'ventilator', 'mechanical ventilation', 'vasopressor', 'sepsis', 'septic shock', 'organ failure',
  'icu length of stay', 'icu admission', 'extracorporeal', 'ecmo', 'renal replacement', 'shock'];

/** closes: suppression_rules "public-health / epi-only" */
const EPI_TA = ['prevalence', 'incidence trends', 'national burden', 'surveillance', 'seroprevalence',
  'cross-sectional survey', 'disease burden', 'epidemiological trends', 'population-based survey',
  'registry description', 'health services utilization'];
/** a clinical-care implication rescues an epi paper */
const CLINICAL_IMPLICATION_TA = ['management', 'treatment', 'therapy', 'intervention', 'outcome',
  'mortality', 'guideline', 'protocol-directed', 'bedside', 'clinical decision', 'triage', 'practice'];

/** closes: filter step 4 "protocols / trial registrations" */
/**
 * closes: filter step 4 "protocols / trial registrations".
 * These are matched against the TITLE only. Matching the abstract dropped three
 * papers Neel had starred, because a completed RCT's abstract routinely ends
 * "Trial registration: NCT…" — the phrase marks a real trial as often as a protocol.
 */
const PROTOCOL_TITLE = ['study protocol', 'trial protocol', 'statistical analysis plan',
  'protocol for a randomized', 'protocol for a randomised', 'rationale and design',
  'design and rationale', 'a protocol for'];

// ---------------------------------------------------------------------------

/** Extracts the largest plausible enrolled-N from the abstract. Null when absent. */
export function extractSampleSize(p: Paper): number | null {
  const t = p.abstract || p.title;
  if (!t) return null;
  const cands: number[] = [];
  const pats = [
    /\b[nN]\s*=\s*([0-9][0-9,]{0,7})/g,
    /\b([0-9][0-9,]{1,7})\s+(?:patients|children|infants|neonates|subjects|participants|admissions|episodes|cases)\b/gi,
    /\b(?:included|enrolled|analy[sz]ed|randomi[sz]ed)\s+([0-9][0-9,]{1,7})\b/gi,
  ];
  for (const re of pats) {
    for (const m of t.matchAll(re)) {
      const v = parseInt(m[1].replace(/,/g, ''), 10);
      if (Number.isFinite(v) && v >= 3 && v <= 50_000_000) cands.push(v);
    }
  }
  return cands.length ? Math.max(...cands) : null;
}

function boostList(cfg: WatcherConfig, key: string): { ngrams: string[]; mesh: string[] } {
  const b: any = cfg.scoring?.topic_boosts?.[key] ?? {};
  return { ngrams: b.ngrams ?? [], mesh: b.mesh ?? [] };
}

export function detect(p: Paper, cfg: WatcherConfig): Signals {
  const text = hay(p);
  const ms = meshSet(p);
  const matched: Record<string, string[]> = {};
  const rec = (k: string, v: string[]) => { if (v.length) matched[k] = v; return v.length > 0; };

  // --- boosts -------------------------------------------------------------
  const pediatric = rec('pediatric', [...anyMeshOrText(ms, text, PEDIATRIC_MESH), ...anyHit(text, PEDIATRIC_TA)]);

  const ecmoSec = cfg.sections?.ECMO ?? { mesh_terms: [], title_abstract_terms: [] };
  const ecmo = rec('ecmo', [...anyMeshOrText(ms, text, ecmoSec.mesh_terms), ...anyHit(text, ecmoSec.title_abstract_terms)]);

  const resp = cfg.sections?.Respiratory_ARDS ?? { mesh_terms: [], title_abstract_terms: [] };
  const pardsOrMechVent = rec('pards_or_mech_vent',
    [...anyMeshOrText(ms, text, resp.mesh_terms), ...anyHit(text, resp.title_abstract_terms)]);

  const soc: any = cfg.scoring?.topic_boosts?.society_guideline ?? {};
  const socNames: string[] = soc.societies ?? [];
  const affil = norm(p.authors.map((a) => a.affiliation ?? '').join(' '));
  const societyGuideline = rec('society_guideline', [
    ...anyHit(text, socNames), ...anyHit(affil, socNames),
    ...anyHit(text, ['consensus statement', 'society guideline', 'clinical practice guideline', 'position statement']),
  ]);

  const ai = boostList(cfg, 'informatics_ai_in_cc');
  const informaticsAi = rec('informatics_ai', [...anyMeshOrText(ms, text, ai.mesh), ...anyHit(text, ai.ngrams)]);

  const hemo = boostList(cfg, 'hemodynamic_perfusion_monitoring');
  const hemodynamicMonitoring = rec('hemodynamic', [...anyMeshOrText(ms, text, hemo.mesh), ...anyHit(text, hemo.ngrams)]);

  const eitB = boostList(cfg, 'eit_regional_ventilation');
  const eit = rec('eit', [...anyMeshOrText(ms, text, eitB.mesh), ...anyHit(text, eitB.ngrams)]);

  // --- suppression --------------------------------------------------------
  const covidHits = [...anyMesh(ms, COVID_MESH), ...anyHit(text, COVID_TA)];
  // "COVID-only" means COVID dominates, not merely appears. Require a title hit
  // or >=3 body mentions, and no competing CC topic carrying the paper.
  // Title only. An abstract-density rule dropped a starred ARDS subphenotype
  // paper that merely discussed COVID as one cause: a paper that is *about*
  // COVID says so in its title.
  const covidInTitle = anyHit(norm(p.title), COVID_TA).length > 0;
  const covidOnly = rec('covid_only',
    covidInTitle && !ecmo && !eit && !pardsOrMechVent ? covidHits : []);

  const surgHits = anyHit(text, SURGICAL_TA);
  const ccOutcome = anyHit(text, CC_OUTCOME_TA);
  const surgicalTechnique = rec('surgical_technique',
    surgHits.length && ccOutcome.length === 0 ? surgHits : []);

  // Requires the epidemiology signal in the TITLE, no clinical-implication
  // language anywhere, and no critical-care relevance. Matching the abstract
  // alone dropped a starred neurocritical-care paper whose title merely opened
  // with the word "Prevalence".
  const epiHits = anyHit(norm(p.title), EPI_TA);
  const impl = anyHit(text, CLINICAL_IMPLICATION_TA);
  const gateTerms = cfg.tier_3_cc_relevance_gate_criteria ?? { mesh_terms_any_of: [], title_abstract_any_of: [] };
  const ccEvidence = [...anyMeshOrText(ms, text, gateTerms.mesh_terms_any_of),
                      ...anyHit(text, gateTerms.title_abstract_any_of)];
  const epiOnly = rec('epi_only',
    epiHits.length && impl.length === 0 && ccEvidence.length === 0 ? epiHits : []);

  const isProtocol = rec('protocol', [
    ...anyHit(norm(p.title), PROTOCOL_TITLE),
    ...(p.pubTypes.includes('Clinical Trial Protocol') ? ['pt:Clinical Trial Protocol'] : []),
  ]);

  // --- Tier-3 critical-care relevance gate --------------------------------
  const gate = cfg.tier_3_cc_relevance_gate_criteria ?? { mesh_terms_any_of: [], title_abstract_any_of: [] };
  const ccRelevant = rec('cc_relevance', [
    ...anyMeshOrText(ms, text, gate.mesh_terms_any_of), ...anyHit(text, gate.title_abstract_any_of),
  ]);

  return {
    pediatric, ecmo, pardsOrMechVent, societyGuideline, informaticsAi,
    hemodynamicMonitoring, eit, covidOnly, surgicalTechnique, epiOnly,
    isProtocol, ccRelevant, sampleSize: extractSampleSize(p), matched,
  };
}
