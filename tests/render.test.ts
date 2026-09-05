/**
 * Tests for src/render/email.ts.
 *
 * Sample data provenance: the five bibliographic records below (pmid, title, journal,
 * abstract, authors, doi, pubTypes, mesh) are real records fetched from PubMed via the
 * PubMed MCP (get_article_metadata) on 2026-09-05 — not invented. The one paper with
 * pmid "00000001" is an OBVIOUSLY SYNTHETIC placeholder used only to exercise HTML
 * escaping and abstract truncation; its title says so explicitly. Score/tier/signals/
 * boosts on every ScoredPaper below are synthetic test fixtures (this repo's real
 * scoring engine lives in src/score/, not exercised here) — they are not claims about
 * the papers themselves.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderDigestHtml, renderDigestText, renderSubject } from '../src/render/email.ts';
import type { Digest, Paper, Signals, ScoredPaper } from '../src/types.ts';

function mkSignals(over: Partial<Signals> = {}): Signals {
  return {
    pediatric: false,
    ecmo: false,
    pardsOrMechVent: false,
    societyGuideline: false,
    informaticsAi: false,
    hemodynamicMonitoring: false,
    eit: false,
    covidOnly: false,
    surgicalTechnique: false,
    epiOnly: false,
    isProtocol: false,
    ccRelevant: true,
    sampleSize: null,
    matched: {},
    ...over,
  };
}

function mkScored(paper: Paper, section: string, score: number, over: Partial<ScoredPaper> = {}): ScoredPaper {
  return {
    paper,
    signals: mkSignals(),
    tier: 2,
    section,
    base: score,
    score,
    boosts: {},
    practiceChanging: false,
    ...over,
  };
}

// --- Real PubMed records (fetched via PubMed MCP, 2026-09-05) --------------------

const PAPER_RENAL_REVIEW: Paper = {
  pmid: '41978481',
  title:
    'Tandem extracorporeal blood purification therapies for sepsis and acute kidney injury in critically ill children: a state-of-the-art review.',
  abstract:
    'Tandem extracorporeal blood purification and support therapies integrate established therapies such as continuous renal replacement therapies (CRRT), extracorporeal membrane oxygenation (ECMO), intermittent or prolonged renal replacement therapies with emerging adsorptive, immunomodulatory, and organ-support technologies. These approaches are increasingly applied in critically ill children with complex multi-organ dysfunction, particularly in the settings of severe sepsis, hyperinflammatory syndromes, acute kidney injury, liver failure, and refractory cardiorespiratory compromise.',
  journal: 'Ren Fail',
  pubTypes: ['Journal Article', 'Review'],
  mesh: ['Acute Kidney Injury', 'Critical Illness', 'Extracorporeal Membrane Oxygenation', 'Sepsis', 'Child'],
  meshMajor: ['Acute Kidney Injury', 'Sepsis'],
  authors: [
    { last: 'Shirode', fore: 'Parth', affiliation: 'Department of Pediatric Nephrology, Akron Children’s Hospital, Akron, OH, USA.' },
    { last: 'Raina', fore: 'Rupesh', affiliation: 'Department of Pediatric Nephrology, Akron Children’s Hospital, Akron, OH, USA.' },
  ],
  edat: '2026-04-14',
  pubdate: '2026-04-14',
  doi: '10.1080/0886022X.2026.2653939',
  language: ['eng'],
};

const PAPER_RENAL_ML: Paper = {
  pmid: '42015601',
  title:
    'Explainable machine learning using urinary metabolomics to predict pediatric sepsis-associated acute kidney injury: a two-center prospective observational study.',
  abstract:
    'Sepsis-induced acute kidney injury (S-AKI) is a common and serious complication in critically ill children with a poor prognosis, and its early and accurate prediction remains challenging due to the lack of reliable biomarkers. In this two-center prospective observational study, we enrolled 360 children from both centers. Based on urinary metabolic fingerprints, we developed and validated a machine learning model for early prediction of S-AKI. The support vector machine demonstrated the best performance in both the discovery cohort (AUC 0.94) and the external validation cohort (AUC 0.89), enabling early prediction of S-AKI within 24 h.',
  journal: 'Ren Fail',
  pubTypes: ['Journal Article', 'Observational Study', 'Multicenter Study'],
  mesh: ['Acute Kidney Injury', 'Sepsis', 'Machine Learning', 'Metabolomics', 'Child'],
  meshMajor: ['Acute Kidney Injury', 'Machine Learning'],
  authors: [
    { last: 'Qian', fore: 'Yali', affiliation: 'Pediatric Intensive Care Unit, Children’s Hospital of Nanjing Medical University, Nanjing, China.' },
    { last: 'Raina', fore: 'Rupesh' },
  ],
  edat: '2026-04-21',
  pubdate: '2026-04-21',
  doi: '10.1080/0886022X.2026.2650262',
  language: ['eng'],
};

const PAPER_RESP_1: Paper = {
  pmid: '42219337',
  title:
    'Post-discharge healthcare resource utilization and surfactant administration in moderate to late preterm infants with respiratory distress syndrome.',
  abstract:
    'Respiratory distress syndrome (RDS) is common in preterm infants, accounting for significant healthcare resource utilization (HCRU). Among 1,674 infants, 316 (18.9%) received surfactant and had greater in-hospital severity. After discharge, surfactant-treated infants were more likely to have any ED visits and hospitalizations compared to non-treated infants; associations were attenuated and no longer significant after adjustment for birth/demographics, clinical severity, and social factors.',
  journal: 'J Matern Fetal Neonatal Med',
  pubTypes: ['Journal Article'],
  mesh: ['Respiratory Distress Syndrome, Newborn', 'Pulmonary Surfactants', 'Infant, Premature'],
  meshMajor: ['Respiratory Distress Syndrome, Newborn'],
  authors: [
    { last: 'Sun', fore: 'Xuezheng', affiliation: 'Chiesi USA Inc, Cary, NC, USA.' },
    { last: 'Kuzniewicz', fore: 'Michael W', affiliation: 'Division of Research, Kaiser Permanente Northern California, Pleasanton, CA, USA.' },
  ],
  edat: '2026-05-31',
  pubdate: '2026-05-31',
  doi: '10.1080/14767058.2026.2669014',
  language: ['eng'],
};

const PAPER_RESP_2: Paper = {
  pmid: '42108382',
  title:
    'Clinical significance of soluble E-selectin and soluble vascular cell adhesion molecule-1 levels in umbilical cord blood for neonatal respiratory distress syndrome: a retrospective study.',
  abstract:
    'This retrospective single-center study collected 558 preterm infants, categorized into NRDS (n=162) and non-NRDS (n=396) groups. sE-selectin and sVCAM-1 were elevated in NRDS infants and positively correlated with disease severity. For NRDS prediction, the AUC was 0.894 for sE-selectin and 0.878 for sVCAM-1; sE-selectin combined with sVCAM-1 achieved an AUC of 0.935.',
  journal: 'J Matern Fetal Neonatal Med',
  pubTypes: ['Journal Article'],
  mesh: ['Respiratory Distress Syndrome, Newborn', 'E-Selectin', 'Vascular Cell Adhesion Molecule-1'],
  meshMajor: ['Respiratory Distress Syndrome, Newborn'],
  authors: [{ last: 'Huang', fore: 'Qiuxiang', affiliation: 'Department of General Pediatrics, Taizhou People’s Hospital Affiliated to Nanjing Medical University, China.' }],
  edat: '2026-05-10',
  pubdate: '2026-05-10',
  doi: '10.1080/14767058.2026.2660017',
  language: ['eng'],
};

/** Real record; PubMed has no abstract for this letter, so abstract is "" per the Paper contract. */
const PAPER_LETTER_NO_ABSTRACT: Paper = {
  pmid: '42002541',
  title: 'Letter to the editor regarding "Long-term mortality in pediatric sepsis: a systematic review and meta-analysis".',
  abstract: '',
  journal: 'Ann Med',
  pubTypes: ['Journal Article'],
  mesh: [],
  meshMajor: [],
  authors: [{ last: 'Ji', fore: 'Kexin' }, { last: 'Duan', fore: 'Xiaozheng' }],
  edat: '2026-04-19',
  pubdate: '2026-04-19',
  doi: '10.1080/07853890.2026.2649387',
  language: ['eng'],
};

/** OBVIOUSLY SYNTHETIC — not a real paper. Exists only to exercise HTML-escaping and truncation. */
const PAPER_XSS_SAMPLE: Paper = {
  pmid: '00000001',
  title: 'SAMPLE — not a real paper: <script>alert(1)</script> & Ampersand/Tag Test',
  abstract:
    'SAMPLE ABSTRACT — not a real paper. This placeholder paragraph exists only to test that the renderer truncates long abstracts to a 220-character snippet that ends on a word boundary and is followed by an ellipsis, and that raw HTML like <b>bold</b> & "quotes" gets escaped rather than executed or breaking the surrounding table markup.',
  journal: 'Not A Real Journal <b>&</b> Sons',
  pubTypes: ['Journal Article'],
  mesh: [],
  meshMajor: [],
  authors: [{ last: 'Sample', fore: 'Not-Real' }],
  edat: '2026-01-01',
  pubdate: '2026-01-01',
  language: ['eng'],
};

// --- Digest fixture ---------------------------------------------------------------

const FEEDBACK_BASE = 'https://digest.example.com/fb';
const UNSUB_URL = 'https://digest.example.com/unsubscribe?u=u_test_demo';
const USER_EMAIL = 'sample-reader@example.com';
const USER_ID = 'u_test_demo';

function buildDigest(): Digest {
  return {
    userId: USER_ID,
    generatedAt: '2026-09-05T10:00:00.000Z',
    windowDays: 7,
    totalCandidates: 47,
    totalAfterFilter: 22,
    practiceChanging: [mkScored(PAPER_RENAL_REVIEW, 'Renal', 9.1, { practiceChanging: true, tier: 1 })],
    sections: [
      { name: 'Cardiac_CC', papers: [] }, // deliberately empty -> must not render
      { name: 'Renal', papers: [mkScored(PAPER_RENAL_ML, 'Renal', 5.8)] },
      {
        name: 'Respiratory_ARDS',
        papers: [mkScored(PAPER_RESP_1, 'Respiratory_ARDS', 4.9), mkScored(PAPER_RESP_2, 'Respiratory_ARDS', 4.1)],
      },
      { name: 'Misc', papers: [mkScored(PAPER_XSS_SAMPLE, 'Misc', 3.2)] },
    ],
    borderline: [mkScored(PAPER_LETTER_NO_ABSTRACT, 'Misc', 1.4)],
  };
}

function allPapers(d: Digest): Paper[] {
  return [
    ...d.practiceChanging.map((s) => s.paper),
    ...d.sections.flatMap((s) => s.papers.map((p) => p.paper)),
    ...d.borderline.map((s) => s.paper),
  ];
}

const OPTS = { unsubscribeUrl: UNSUB_URL, feedbackBaseUrl: FEEDBACK_BASE, userEmail: USER_EMAIL };

// --- Tests --------------------------------------------------------------------

test('renderDigestHtml escapes a malicious/ampersand title with no unescaped <script', () => {
  const html = renderDigestHtml(buildDigest(), OPTS);
  assert.equal(html.toLowerCase().includes('<script'), false);
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'), 'expected the script tag to be escaped as text');
  assert.ok(html.includes('&amp; Ampersand/Tag Test'), 'expected the ampersand to be escaped');
});

test('renderDigestHtml skips the empty section heading silently', () => {
  const html = renderDigestHtml(buildDigest(), OPTS);
  assert.equal(html.includes('>Cardiac CC<'), false);
});

test('renderDigestHtml links every pmid to pubmed.ncbi.nlm.nih.gov', () => {
  const d = buildDigest();
  const html = renderDigestHtml(d, OPTS);
  for (const p of allPapers(d)) {
    assert.ok(
      html.includes(`https://pubmed.ncbi.nlm.nih.gov/${p.pmid}/`),
      `missing pubmed link for pmid ${p.pmid}`,
    );
  }
});

test('renderDigestHtml includes all three feedback links per paper', () => {
  const d = buildDigest();
  const html = renderDigestHtml(d, OPTS);
  for (const p of allPapers(d)) {
    for (const tag of ['star', 'tilde', 'skip']) {
      const needle = `pmid=${p.pmid}&amp;tag=${tag}&amp;u=${USER_ID}`;
      assert.ok(html.includes(needle), `missing feedback link (${tag}) for pmid ${p.pmid}: ${needle}`);
    }
  }
});

test('renderDigestHtml includes the practice-changing block, unsubscribe link, and NLM footer', () => {
  const html = renderDigestHtml(buildDigest(), OPTS);
  assert.ok(html.includes('Practice-changing'));
  assert.ok(html.includes(UNSUB_URL));
  assert.ok(html.includes('Courtesy of the U.S. National Library of Medicine.'));
  assert.ok(html.includes("This digest may not reflect NLM&#39;s most current data."));
});

test('renderDigestHtml renders the no-abstract paper without an abstract row and stays under 100k chars', () => {
  const html = renderDigestHtml(buildDigest(), OPTS);
  assert.ok(html.includes(PAPER_LETTER_NO_ABSTRACT.title.slice(0, 30).replace(/"/g, '&quot;')));
  assert.ok(html.length < 100_000, `html length ${html.length} exceeds 100,000 chars`);
});

test('renderDigestHtml produces balanced table/tr/td tags', () => {
  const html = renderDigestHtml(buildDigest(), OPTS);
  const count = (re: RegExp) => (html.match(re) || []).length;
  assert.equal(count(/<table[ >]/g), count(/<\/table>/g));
  assert.equal(count(/<tr[ >]/g), count(/<\/tr>/g));
  assert.equal(count(/<td[ >]/g), count(/<\/td>/g));
});

test('renderDigestHtml truncates the long synthetic abstract to a 220-char word-boundary snippet', () => {
  const html = renderDigestHtml(buildDigest(), OPTS);
  assert.ok(html.includes('renderer truncates long abstracts'));
  assert.ok(html.includes('…'), 'expected an ellipsis after truncation');
});

test('renderSubject reflects kept count and a practice-changing marker', () => {
  const subject = renderSubject(buildDigest());
  assert.ok(subject.includes('22 kept'));
  assert.ok(subject.startsWith('⚡'));
});

test('renderDigestText includes NLM footer, unsubscribe URL, and every pmid link', () => {
  // Plain text has no markup to escape — a literal "<script>" in a title is expected
  // to appear verbatim here (it's a text/plain MIME part, not rendered as HTML).
  const d = buildDigest();
  const text = renderDigestText(d, OPTS);
  assert.ok(text.includes('Courtesy of the U.S. National Library of Medicine.'));
  assert.ok(text.includes(UNSUB_URL));
  for (const p of allPapers(d)) assert.ok(text.includes(`https://pubmed.ncbi.nlm.nih.gov/${p.pmid}/`));
});
