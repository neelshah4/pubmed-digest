/**
 * Guards for src/signup-parse.ts — the module .github/workflows/subscribe.yml
 * calls to turn a rendered GitHub Issue Form body into a SignupPrefs object.
 *
 * Each fixture body below is written in the exact shape GitHub renders an
 * Issue Form submission into (verified against a live issue this session —
 * see the comment in src/signup-parse.ts for the source URLs), not a guess
 * at the format.
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { parseIssueBody, FIELD_LABELS } from '../src/signup-parse.ts';
import { ORCID_RE } from '../src/sources/eutils.ts';

function body(fields: Partial<Record<keyof typeof FIELD_LABELS, string>>): string {
  const order: (keyof typeof FIELD_LABELS)[] = [
    'email', 'cadence', 'templates', 'journalTier', 'pubTypes', 'extraKeywords', 'orcidList',
  ];
  return order
    .map((k) => `### ${FIELD_LABELS[k]}\n\n${fields[k] && fields[k]!.length ? fields[k] : '_No response_'}`)
    .join('\n\n');
}

const VALID = body({
  email: 'ryan@example.org',
  cadence: 'weekly',
  templates: '- [x] peds-cc\n- [ ] adult-cc\n- [ ] neurocrit',
  journalTier: 'tier12',
  pubTypes: '- [x] rct\n- [ ] meta-analysis-systematic-review\n- [ ] observational\n- [ ] practice-guideline',
  extraKeywords: 'driving pressure, EIT, VA ECMO',
  orcidList: '0000-0002-1825-0097\n0000-0002-1825-009X Jane Doe',
});

test('valid body parses into a complete SignupPrefs', () => {
  const r = parseIssueBody(VALID);
  assert.strictEqual(r.ok, true);
  if (!r.ok) return;
  assert.strictEqual(r.prefs.email, 'ryan@example.org');
  assert.strictEqual(r.prefs.cadence, 'weekly');
  assert.deepStrictEqual(r.prefs.templates, ['peds-cc']);
  assert.strictEqual(r.prefs.journalTier, 'tier12');
  assert.deepStrictEqual(r.prefs.pubTypes, ['rct']);
  assert.deepStrictEqual(r.prefs.extraKeywords, ['driving pressure', 'EIT', 'VA ECMO']);
  assert.strictEqual(r.prefs.authors.length, 2);
  assert.strictEqual(r.prefs.authors[0].orcid, '0000-0002-1825-0097');
  assert.strictEqual(r.prefs.authors[1].orcid, '0000-0002-1825-009X');
  assert.strictEqual(r.prefs.authors[1].label, 'Jane Doe');
});

test('bad email is rejected with a specific error', () => {
  const r = parseIssueBody(body({ ...fieldsOf(VALID), email: 'not-an-email' }));
  assert.strictEqual(r.ok, false);
  if (r.ok) return;
  assert.ok(r.errors.some((e) => e.includes('not-an-email')), `expected an email error, got: ${r.errors.join(' | ')}`);
});

test('malformed ORCID is rejected and does not silently drop the row', () => {
  const r = parseIssueBody(body({
    email: 'ryan@example.org', cadence: 'weekly', templates: '- [x] peds-cc',
    journalTier: 'all', orcidList: '1234',
  }));
  assert.strictEqual(r.ok, false);
  if (r.ok) return;
  assert.ok(r.errors.some((e) => e.includes('1234')), `expected an ORCID error, got: ${r.errors.join(' | ')}`);
});

test('unknown template slug is rejected', () => {
  const r = parseIssueBody(body({
    email: 'ryan@example.org', cadence: 'weekly',
    templates: '- [x] neuro-cc', // real slug is "neurocrit" — this must fail
    journalTier: 'all',
  }));
  assert.strictEqual(r.ok, false);
  if (r.ok) return;
  assert.ok(r.errors.some((e) => e.includes('neuro-cc')), `expected an unknown-template error, got: ${r.errors.join(' | ')}`);
});

test('empty body fails with errors for every required field, and does not throw', () => {
  const r = parseIssueBody('');
  assert.strictEqual(r.ok, false);
  if (r.ok) return;
  assert.ok(r.errors.length >= 4, `expected several missing-field errors, got: ${JSON.stringify(r.errors)}`);
  assert.ok(r.errors.some((e) => e.includes(FIELD_LABELS.email)));
  assert.ok(r.errors.some((e) => e.includes(FIELD_LABELS.cadence)));
  assert.ok(r.errors.some((e) => e.includes('specialty template')));
  assert.ok(r.errors.some((e) => e.includes(FIELD_LABELS.journalTier)));
});

test('ORCID_RE (shared with sources/eutils.ts) matches the contract test vectors', () => {
  assert.strictEqual(ORCID_RE.test('0000-0002-1825-0097'), true);
  assert.strictEqual(ORCID_RE.test('0000-0002-1825-009X'), true);
  assert.strictEqual(ORCID_RE.test('1234'), false);
});

test('optional fields left as "_No response_" render as empty, not the literal string', () => {
  const r = parseIssueBody(body({
    email: 'ryan@example.org', cadence: 'monthly', templates: '- [x] adult-cc', journalTier: 'tier1',
    // pubTypes, extraKeywords, orcidList all default to "_No response_"
  }));
  assert.strictEqual(r.ok, true);
  if (!r.ok) return;
  assert.deepStrictEqual(r.prefs.pubTypes, []);
  assert.deepStrictEqual(r.prefs.extraKeywords, []);
  assert.deepStrictEqual(r.prefs.authors, []);
});

// Rebuilds the field map VALID was built from, so the other tests can override
// just one field without repeating the whole fixture.
function fieldsOf(_rendered: string): Partial<Record<keyof typeof FIELD_LABELS, string>> {
  return {
    email: 'ryan@example.org',
    cadence: 'weekly',
    templates: '- [x] peds-cc\n- [ ] adult-cc\n- [ ] neurocrit',
    journalTier: 'tier12',
    pubTypes: '- [x] rct',
    extraKeywords: 'driving pressure, EIT, VA ECMO',
    orcidList: '0000-0002-1825-0097\n0000-0002-1825-009X Jane Doe',
  };
}
