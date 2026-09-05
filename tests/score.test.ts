/**
 * Regression guards for four defects found by running the pipeline against live
 * PubMed. Each test fails against the pre-fix code.
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { loadTemplate } from '../src/config.ts';
import { assignSection, buildDigest, scorePaper } from '../src/score/score.ts';
import { detect } from '../src/score/detect.ts';
import type { Paper } from '../src/types.ts';

const cfg = loadTemplate('peds-cc');

const mk = (o: Partial<Paper>): Paper => ({
  pmid: '00000001', title: 'SAMPLE', abstract: '', journal: 'Crit Care Med',
  pubTypes: ['Journal Article'], mesh: [], meshMajor: [], authors: [],
  edat: '2026-09-01', pubdate: '2026-09-01', language: ['eng'], ...o,
});

test('substring matching does not mis-section: "taking" is not AKI', () => {
  const p = mk({ title: 'Adherence to taking prescribed medication', abstract: 'A study of which patients comply.' });
  const sec = assignSection(p, detect(p, cfg), cfg);
  assert.notStrictEqual(sec, 'Renal', '"taking" must not match the AKI term');
  assert.notStrictEqual(sec, 'Neurocritical_Care', '"which" must not match the ICH term');
});

test('MeSH descriptors match as text when PubMed has not indexed the paper', () => {
  // 73.4% of a live 7-day window had no MeSH. "Sepsis" exists only as a MeSH
  // term in the config, so a title hit must still route to Shock_Sepsis.
  const p = mk({ title: 'Healthcare Encounters Preceding a Sepsis Hospitalization', mesh: [] });
  assert.strictEqual(assignSection(p, detect(p, cfg), cfg), 'Shock_Sepsis');
});

test('title outranks incidental MeSH when assigning a section', () => {
  const p = mk({ title: 'Septic shock resuscitation in children', mesh: ['Respiration, Artificial'] });
  assert.strictEqual(assignSection(p, detect(p, cfg), cfg), 'Shock_Sepsis');
});

test('general-scope journals must clear the CC gate whatever their tier', () => {
  const backPain = mk({ journal: 'Cochrane Database Syst Rev', title: 'Lumbar supports for low back pain',
    abstract: 'Assistive technologies for treating low back pain in adults.' });
  assert.strictEqual(scorePaper(backPain, cfg), null, 'Cochrane non-CC review must be dropped');

  const ccReview = mk({ journal: 'Cochrane Database Syst Rev', title: 'Prone positioning in ARDS',
    abstract: 'Mechanical ventilation strategies for critically ill patients in intensive care.' });
  assert.ok(scorePaper(ccReview, cfg), 'Cochrane CC review must be kept');
});

test('digest respects the hard cap and does not duplicate the Misc section', () => {
  // 'Misc' is both a config section key and the fallback name; appending it
  // produced duplicate entries and pushed the digest over its cap.
  // These must land in the Misc SECTION specifically: 'Misc' is a real config
  // section key, and the bug appended it a second time as the fallback, so only
  // Misc-sectioned papers expose the duplication.
  const pool = Array.from({ length: 200 }, (_, i) =>
    mk({ pmid: String(100000 + i), title: `ICU delirium and early mobility cohort ${i}`,
         abstract: 'ICU delirium, sedation and early mobility among critically ill patients in intensive care.' }));
  const d = buildDigest(pool, cfg, 'u', 7);
  const shown = [...d.practiceChanging, ...d.sections.flatMap((s) => s.papers)];
  assert.ok(shown.length <= cfg.digest.hard_cap, `shown ${shown.length} exceeds cap ${cfg.digest.hard_cap}`);
  assert.strictEqual(new Set(d.sections.map((s) => s.name)).size, d.sections.length, 'duplicate section');
  assert.strictEqual(new Set(shown.map((s) => s.paper.pmid)).size, shown.length, 'duplicate paper');
});

test('practice-changing papers past the top 3 stay in their sections', () => {
  const pool = Array.from({ length: 8 }, (_, i) =>
    mk({ pmid: String(200000 + i), journal: 'Crit Care Med',
         pubTypes: ['Journal Article', 'Randomized Controlled Trial'],
         title: `Trial of sepsis therapy ${i}`,
         abstract: `Septic shock RCT enrolling ${300 + i} critically ill patients in intensive care.` }));
  const d = buildDigest(pool, cfg, 'u', 7);
  const shown = [...d.practiceChanging, ...d.sections.flatMap((s) => s.papers)];
  assert.ok(d.practiceChanging.length <= 3, 'at most 3 pinned');
  assert.strictEqual(shown.length, new Set(shown.map((s) => s.paper.pmid)).size, 'no duplicates');
  assert.ok(shown.length >= Math.min(pool.length, 5), 'papers beyond the top 3 must not vanish');
});

test('the protected gold floor survives feedback with no new tags', async () => {
  const { applyFeedback, positiveVec } = await import('../src/score/profile.ts');
  const lp = cfg.preference_profile.learned_profile;
  const before = Object.keys(positiveVec(lp)).length;
  const after = Object.keys(positiveVec(applyFeedback(lp, []))).length;
  assert.ok(before > 0, 'gold floor must be non-empty to be meaningful');
  assert.strictEqual(after, before, 'a run with no tags must not blank the positive profile');
});
