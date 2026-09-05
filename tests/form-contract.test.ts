/**
 * The signup form and the pipeline are edited by different people at different
 * times, and nothing structural connected them. Two values had already drifted:
 * the form sent "meta-analysis-systematic-review" and "practice-guideline" while
 * the pipeline understood "meta" and "guideline", and an `?? [key]` fallback
 * turned the mismatch into a restriction that matched nothing — ticking
 * "Meta-Analysis" silently produced an empty digest instead of an error.
 *
 * These tests read the real form and assert every value it can emit is one the
 * pipeline actually honours.
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync, readdirSync } from 'node:fs';
import { expandPubTypes, unknownPubTypes, configFor, DEFAULT_PREFS } from '../src/prefs.ts';

const form = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');

/** Values of every input with the given name attribute, in either attribute order. */
function formValues(name: string): string[] {
  const out = new Set<string>();
  for (const m of form.matchAll(new RegExp(`<input[^>]*>`, 'g'))) {
    const tag = m[0];
    if (!new RegExp(`name=["']${name}["']`).test(tag)) continue;
    const v = tag.match(/value=["']([^"']+)["']/);
    if (v) out.add(v[1]);
  }
  return [...out];
}

test('every publication type the form offers maps to real PubMed types', () => {
  const values = formValues('pubTypes');
  assert.ok(values.length >= 3, `expected several pubType inputs, found ${values.length}`);
  assert.deepStrictEqual(unknownPubTypes(values), [],
    'the form can emit a publication type the pipeline does not understand');
  for (const v of values) {
    const expanded = expandPubTypes([v]);
    assert.ok(expanded.length > 0, `"${v}" expands to nothing, which empties the digest`);
    for (const pt of expanded) {
      assert.ok(/^[A-Z]/.test(pt) && /[a-z]/.test(pt),
        `"${v}" produced "${pt}", which is not a PubMed publication type`);
    }
  }
});

test('every journal-tier value the form offers is one configFor understands', () => {
  const values = formValues('journalTier');
  assert.ok(values.length >= 2, `expected tier radios, found ${values.length}`);
  const sizes = new Map<string, number>();
  for (const v of values) {
    const cfg = configFor({ ...DEFAULT_PREFS, journalTier: v as never });
    const n = cfg.journals.tier_1_primary_cc.length
      + cfg.journals.tier_2_top_general_plus_adjacent.length
      + cfg.journals.tier_3_cc_relevance_gate.length;
    assert.ok(n > 0, `tier value "${v}" yields no journals`);
    sizes.set(v, n);
  }
  // An unrecognised tier value silently falls through to "all", so identical
  // sizes across every option means a value has drifted.
  assert.strictEqual(new Set(sizes.values()).size, sizes.size,
    `tier options do not produce distinct journal sets: ${JSON.stringify([...sizes])}`);
});

test('every template the form offers has a backing template file', () => {
  const values = formValues('templates');
  assert.ok(values.length >= 1, 'expected template checkboxes');
  const onDisk = new Set(readdirSync(new URL('../src/', import.meta.url))
    .filter((f) => f.endsWith('.template.json'))
    .map((f) => f.replace('.template.json', '')));
  for (const v of values) {
    assert.ok(onDisk.has(v),
      `form offers template "${v}" but src/${v}.template.json does not exist — loadTemplate would throw`);
  }
});
