/**
 * Guards the seam between web/index.html (the query builder) and the vetted
 * config it draws on.
 *
 * The page and the templates are edited at different times and nothing
 * structurally connects them. The previous version of this file caught two real
 * drifts before they shipped. The builder no longer posts to a backend, so what
 * has to hold now is different: the journals it offers must be ones the curated
 * config actually vetted, and every value it puts into a PubMed query must be a
 * real PubMed field value.
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { loadTemplate } from '../src/config.ts';

const page = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');

/** Values of a JS array literal declared as `const NAME = [ ... ];` in the page. */
function jsArray(name: string): string[] {
  const m = page.match(new RegExp(`const ${name}\\s*=\\s*\\[([\\s\\S]*?)\\];`));
  assert.ok(m, `could not find const ${name} in web/index.html`);
  return [...m![1].matchAll(/['"]([^'"]+)['"]/g)].map((x) => x[1]);
}

test('every curated journal ships with a measured monthly count', () => {
  // Each entry is [journalName, articlesPerMonth]. The count is not decoration:
  // it is evidence the name was checked against live PubMed before shipping. One
  // candidate ("Pediatr Crit Care Med Open") matched nothing and was dropped.
  const block = page.match(/const GROUPS = \{([\s\S]*?)\n\};/);
  assert.ok(block, 'GROUPS not found in web/index.html');
  const entries = [...block![1].matchAll(/\['([^']+)',\s*(\d+)\]/g)];
  assert.ok(entries.length >= 50, `expected a substantial journal set, found ${entries.length}`);
  for (const [, name, n] of entries) {
    assert.ok(name.trim().length > 2, `bad journal name: "${name}"`);
    assert.ok(Number.isInteger(+n) && +n >= 0, `"${name}" has no measured count`);
  }
});

test('there are enough groups, each with enough journals to be worth grouping', () => {
  const block = page.match(/const GROUPS = \{([\s\S]*?)\n\};/)![1];
  const groups = [...block.matchAll(/^\s*'([^']+)':\s*\[/gm)].map((m) => m[1]);
  assert.ok(groups.length >= 5 && groups.length <= 12,
    `expected 5 to 12 groups, found ${groups.length}: ${groups.join(', ')}`);
  for (const line of block.split('\n').filter((l) => l.includes("': ["))) {
    const name = line.match(/'([^']+)':/)![1];
    const n = (line.match(/\['/g) || []).length;
    assert.ok(n >= 3, `group "${name}" has only ${n} journals; groups that small are noise`);
  }
});

test('the pediatric critical care group stays anchored to the vetted whitelist', () => {
  // The groups deliberately reach beyond peds CC now, but the peds CC group
  // itself must still overlap the config Neel actually curated, or the curation
  // has quietly stopped meaning anything.
  const block = page.match(/const GROUPS = \{([\s\S]*?)\n\};/)![1];
  const line = block.split('\n').find((l) => l.includes("'Pediatric critical care'"));
  assert.ok(line, 'no pediatric critical care group');
  const names = [...line!.matchAll(/\['([^']+)',/g)].map((m) => m[1]);
  const cfg = loadTemplate('peds-cc');
  const vetted = new Set([...cfg.journals.tier_1_primary_cc,
    ...cfg.journals.tier_2_top_general_plus_adjacent,
    ...cfg.journals.tier_3_cc_relevance_gate].map((j) => j.toLowerCase()));
  const overlap = names.filter((n) => vetted.has(n.toLowerCase()));
  assert.ok(overlap.length >= 2,
    `peds CC group overlaps the vetted whitelist in only ${overlap.length} journals: ${names.join(', ')}`);
});

test('the study-type control carries its measured warning', () => {
  // Measured 2026-09-06: of articles indexed in the previous 30 days, 0 of 15 in
  // PCCM carried any study-type tag. Shipping the control without the warning
  // would hand users a filter that silently empties their alert.
  assert.ok(/showTypeCost/.test(page), 'no live cost readout for study types');
  assert.ok(/indexing/i.test(page), 'the warning must explain indexing lag');
  assert.ok(/id="ptWarn"/.test(page), 'no warning element');
  const checked = page.match(/id="ptypes"[\s\S]{0,400}?checked/);
  assert.ok(!checked, 'no study type may be checked by default');
});

test('every publication type offered is a real PubMed publication type', () => {
  // PTYPES entries are [pubmedString, humanLabel]; the first is what enters the query.
  const all = jsArray('PTYPES');
  const pts = all.filter((_, i) => i % 2 === 0);
  assert.ok(pts.length >= 4, `expected several publication types, found ${pts.length}`);
  const known = new Set(['Randomized Controlled Trial', 'Meta-Analysis', 'Systematic Review',
    'Practice Guideline', 'Observational Study', 'Multicenter Study', 'Clinical Trial',
    'Guideline', 'Comparative Study', 'Validation Study']);
  for (const pt of pts) {
    assert.ok(known.has(pt),
      `"${pt}" is not a PubMed publication type; it would silently match nothing`);
  }
});

test('the recency window is a request parameter, never part of the query term', () => {
  // `AND 30[edat]` is not PubMed syntax: it matches nothing and reports zero
  // volume without erroring. This shipped once and was only caught by running it.
  assert.ok(/reldate\s*:/.test(page), 'the page must pass reldate as a request parameter');
  assert.ok(!/AND\s+\$?\{?\d+\}?\[edat\]/.test(page.replace(/\/\*[\s\S]*?\*\//g, '')),
    'a bare N[edat] clause is in a query term outside a comment');
});

test('cadence and delivery options are exactly the values the code branches on', () => {
  const cadences = [...page.matchAll(/name="cadence"\s+value="([^"]+)"/g)].map((m) => m[1]);
  assert.deepStrictEqual(cadences.sort(), ['monthly', 'weekly'],
    'cadence radios must be weekly and monthly, which is all My NCBI offers alongside daily');
  const splits = [...page.matchAll(/name="split"\s+value="([^"]+)"/g)].map((m) => m[1]);
  assert.deepStrictEqual(splits.sort(), ['combined', 'split']);
});

test('the page never collects an email address', () => {
  // PubMed sends the mail from the address on the user's My NCBI account. A field
  // here would imply this site emails them, which it does not and must not.
  assert.ok(!/type=["']email["']/.test(page), 'the builder must not collect an email address');
  assert.ok(/no email address is ever collected/i.test(page),
    'the footer must state plainly that no address is collected');
});

test('required attribution and currency notices are present', () => {
  assert.ok(/National Library of Medicine/.test(page), 'NLM courtesy line missing');
  assert.ok(/most current data/i.test(page), 'NLM currency disclaimer missing');
  assert.ok(/[Nn]ot affiliated/.test(page), 'non-affiliation statement missing');
});

test('every interactive control is reachable and labelled', () => {
  const inputs = [...page.matchAll(/<input[^>]*>/g)].map((m) => m[0]);
  for (const i of inputs) {
    const isChoice = /type="(checkbox|radio)"/.test(i);
    const id = i.match(/id="([^"]+)"/)?.[1];
    assert.ok(isChoice || id, `an input has neither a wrapping choice label nor an id: ${i.slice(0, 60)}`);
    if (id) {
      assert.ok(new RegExp(`for="${id}"`).test(page), `input #${id} has no <label for>`);
    }
  }
  assert.ok(/:focus-visible/.test(page), 'no visible focus style');
});

test('author names are never quoted in an [au] clause', () => {
  // Measured 2026-09-06 against live PubMed: quoting forces exact phrase matching
  // on the author index and silently drops records indexed under a fuller name.
  //   Kolmar A[au]  -> 17     "Kolmar A"[au]  -> 10
  //   Barbaro R[au] -> 155    "Barbaro R"[au] -> 43   (72% loss)
  //   Shah N[au]    -> 9846   "Shah N"[au]    -> 4402
  // Journals [ta] and publication types [pt] return identical counts either way,
  // so they keep their quotes; only [au] must stay bare.
  // Strip comments first: the explanation of this rule quotes the bad form, and
  // an earlier version of this test flagged that documentation as a violation.
  const code = page.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const quotedAu = code.match(/"\$\{[^}]*\}"\[au\]|"[^"]*"\[au\]/g) || [];
  assert.deepStrictEqual(quotedAu, [],
    `author clauses are quoted, which silently loses matches: ${quotedAu.join(', ')}`);
  assert.ok(/\[au\]/.test(code), 'expected at least one [au] clause to exist');
});

test('journal clauses keep their quotes', () => {
  // Multi-word journal titles need the phrase form, and quoting costs nothing there.
  assert.ok(/"\$\{[^}]*\}"\[ta\]|"[^"]*"\[ta\]/.test(page),
    'journal clauses should be quoted');
});
