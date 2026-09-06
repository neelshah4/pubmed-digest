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

test('every curated journal is one the vetted peds-CC template whitelists', () => {
  const curated = jsArray('CURATED');
  assert.ok(curated.length >= 10, `expected a real curated list, found ${curated.length}`);
  const cfg = loadTemplate('peds-cc');
  const vetted = new Set([
    ...cfg.journals.tier_1_primary_cc,
    ...cfg.journals.tier_2_top_general_plus_adjacent,
  ].map((j) => j.toLowerCase()));
  for (const j of curated) {
    assert.ok(vetted.has(j.toLowerCase()),
      `"${j}" is offered as curated but is not in the vetted tier-1/2 whitelist`);
  }
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
