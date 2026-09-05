/** Guards for the preference layer and author watching. */
import { test } from 'node:test';
import assert from 'node:assert';
import { configFor, expandPubTypes, matchesKeywords, DEFAULT_PREFS } from '../src/prefs.ts';
import { buildDigest } from '../src/score/score.ts';
import { ORCID_RE } from '../src/sources/eutils.ts';
import type { Paper, SignupPrefs } from '../src/types.ts';

const mk = (o: Partial<Paper>): Paper => ({
  pmid: '00000001', title: 'SAMPLE', abstract: '', journal: 'Crit Care Med',
  pubTypes: ['Journal Article'], mesh: [], meshMajor: [], authors: [],
  edat: '2026-09-01', pubdate: '2026-09-01', language: ['eng'], ...o,
});
const P = (o: Partial<SignupPrefs> = {}): SignupPrefs => ({ ...DEFAULT_PREFS, ...o });
const count = (c: any) => c.journals.tier_1_primary_cc.length
  + c.journals.tier_2_top_general_plus_adjacent.length + c.journals.tier_3_cc_relevance_gate.length;

test('journal tier choice actually narrows the journal set', () => {
  assert.strictEqual(count(configFor(P({ journalTier: 'tier1' }))), 17);
  assert.strictEqual(count(configFor(P({ journalTier: 'tier12' }))), 26);
  assert.strictEqual(count(configFor(P({ journalTier: 'all' }))), 69);
});

test('publication-type groups expand to real PubMed PT strings', () => {
  const pts = expandPubTypes(['rct', 'meta']);
  assert.ok(pts.includes('Randomized Controlled Trial'));
  assert.ok(pts.includes('Systematic Review'));
  assert.strictEqual(expandPubTypes([]).length, 0, 'empty means no restriction, not nothing');
});

test('an empty publication-type selection does not filter everything out', () => {
  const pool = [mk({ pmid: '1', title: 'Septic shock in the PICU', abstract: 'Critically ill children in intensive care.' })];
  const d = buildDigest(pool, configFor(P()), 'u', 7, { prefs: P() });
  assert.strictEqual(d.totalAfterFilter, 1, 'no PT chosen must mean no PT restriction');
});

test('user keywords boost a paper and record why', () => {
  const p = mk({ title: 'Electrical impedance tomography during prone positioning',
                 abstract: 'Regional ventilation in ARDS patients in intensive care.' });
  const prefs = P({ extraKeywords: ['electrical impedance tomography'] });
  assert.deepStrictEqual(matchesKeywords(p, prefs), ['electrical impedance tomography']);
  const d = buildDigest([p], configFor(prefs), 'u', 7, { prefs });
  const shown = d.sections.flatMap((s) => s.papers).concat(d.practiceChanging);
  assert.ok(shown[0].signals.matched.user_keywords, 'keyword match must be recorded in the audit trail');
  assert.strictEqual(shown[0].boosts.keyword, 1.25);
});

test('a followed author bypasses the journal whitelist', () => {
  // Eur J Heart Fail is deliberately NOT in the critical-care whitelist.
  const p = mk({ pmid: '999', journal: 'Eur J Heart Fail', title: 'Heart failure therapy trial',
                 abstract: 'Blood pressure and kidney function outcomes.' });
  const prefs = P();
  const noWatch = buildDigest([p], configFor(prefs), 'u', 7, { prefs });
  assert.strictEqual(noWatch.totalAfterFilter, 0, 'off-whitelist journal is dropped without a watch');

  const hits = new Map([['999', { orcid: '0000-0003-3698-9597', label: 'Watched Author' }]]);
  const withWatch = buildDigest([p], configFor(prefs), 'u', 7, { prefs, authorHits: hits });
  assert.strictEqual(withWatch.authorPapers.length, 1, 'a followed author is wanted wherever they publish');
  assert.strictEqual(withWatch.authorPapers[0].authorMatch?.label, 'Watched Author');
});

test('a followed author is never hidden by a publication-type restriction', () => {
  const p = mk({ pmid: '888', journal: 'Eur J Heart Fail', pubTypes: ['Editorial'],
                 title: 'Commentary on heart failure', abstract: 'A short comment.' });
  const prefs = P({ pubTypes: ['rct'] });
  const hits = new Map([['888', { orcid: '0000-0003-3698-9597', label: 'Watched' }]]);
  const d = buildDigest([p], configFor(prefs), 'u', 7, { prefs, authorHits: hits });
  assert.strictEqual(d.authorPapers.length, 1);
});

test('an author paper is not also duplicated into the journal sections', () => {
  const p = mk({ pmid: '777', journal: 'Crit Care Med', title: 'Septic shock trial in children',
                 abstract: 'Critically ill children in the PICU with septic shock.' });
  const hits = new Map([['777', { orcid: '0000-0003-3698-9597' }]]);
  const d = buildDigest([p], configFor(P()), 'u', 7, { prefs: P(), authorHits: hits });
  const inSections = d.sections.flatMap((s) => s.papers).filter((x) => x.paper.pmid === '777');
  assert.strictEqual(d.authorPapers.length, 1);
  assert.strictEqual(inSections.length, 0, 'must appear once, under its author');
});

test('ORCID validation rejects anything that is not an ORCID', () => {
  for (const good of ['0000-0002-1825-0097', '0000-0003-3698-9597', '0000-0002-1825-009X']) {
    assert.ok(ORCID_RE.test(good), good);
  }
  for (const bad of ['1234', 'Smith J', '0000-0002-1825-00977', 'https://orcid.org/0000-0002-1825-0097', '']) {
    assert.ok(!ORCID_RE.test(bad), bad);
  }
});
