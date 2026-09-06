/**
 * Author disambiguation, tested against records captured from live PubMed for
 * six real people (tests/fixtures/authors, harvested 2026-09-06).
 *
 * Two failure modes, and they are not symmetric. Missing a paper is a nuisance.
 * MERGING TWO DIFFERENT PEOPLE silently fills someone's alert with a stranger's
 * work, and they may never notice. The precision cases below are therefore the
 * ones that matter most: this surname set deliberately contains pairs who share
 * a name and are not the same person.
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { clusterAuthors, compatible, institutionKey, similarity, sameInstitution } from '../web/disambiguate.js';

const load = (slug: string) =>
  JSON.parse(readFileSync(new URL(`./fixtures/authors/${slug}.json`, import.meta.url), 'utf8')).records;

/** Total PubMed records for the bare name query, measured 2026-09-06. */
const TOTALS: Record<string, number> = {
  'kolmar-a': 17, 'barbaro-r': 155, 'shah-n': 9846,
  'said-a': 3200, 'raman-l': 2100, 'sanford-e': 1400,
};
const cluster = (slug: string) =>
  clusterAuthors(load(slug), { totalForName: TOTALS[slug] });
const withFore = (cs: any[], fore: string) =>
  cs.filter((c) => c.fore.toLowerCase().startsWith(fore.toLowerCase()));

// ---------------------------------------------------------------- recall ----

test('Kolmar A collapses to a single person', () => {
  // Neel confirmed every one of these is Amanda Kolmar. Before the cluster-level
  // pass this produced ten candidates, because the grouping key was the
  // department and her forename alternates between "Amanda" and "Amanda R".
  const cs = cluster('kolmar-a');
  const amanda = withFore(cs, 'Amanda');
  assert.strictEqual(amanda.length, 1, `expected one Amanda Kolmar, got ${amanda.length}`);
  assert.strictEqual(amanda[0].n, load('kolmar-a').length, 'every record should be hers');
  assert.strictEqual(amanda[0].orcid, '0000-0002-4703-2937', 'her ORCID should survive the merge');
  assert.ok(amanda[0].insts.length > 1, 'she has worked at more than one institution');
});

test('Ryan Barbaro consolidates despite affiliation missing on most records', () => {
  // 70 of 110 of his records carry no affiliation at all, so affiliation cannot
  // carry this; co-authorship does.
  const cs = cluster('barbaro-r');
  const ryan = withFore(cs, 'Ryan').sort((a, b) => b.n - a.n);
  assert.ok(ryan[0].n >= 100, `dominant Ryan cluster only has ${ryan[0].n}`);
  assert.strictEqual(ryan[0].orcid, '0000-0002-3645-0359');
});

test('Lakshmi Raman consolidates across her institution spellings', () => {
  const cs = cluster('raman-l');
  const top = withFore(cs, 'Lakshmi').sort((a, b) => b.n - a.n)[0];
  assert.ok(top.n >= 60, `dominant Lakshmi cluster only has ${top.n}`);
  assert.strictEqual(top.orcid, '0000-0002-7676-1346');
});

// -------------------------------------------------------------- precision ----

test('two different Ethan Sanfords are NOT merged', () => {
  // Ethan L Sanford (UT Southwestern) and Ethan James Sanford (Weill Institute)
  // share a first name, a surname and an initial, and are different people.
  const cs = cluster('sanford-e');
  const ethans = withFore(cs, 'Ethan').filter((c) => c.n >= 5);
  assert.ok(ethans.length >= 2, 'the two Ethan Sanfords collapsed into one person');
  const orcids = new Set(ethans.map((c) => c.orcid).filter(Boolean));
  assert.ok(orcids.has('0000-0002-7423-6521') && orcids.has('0000-0003-0722-3058'),
    'both Ethan Sanford ORCIDs should survive as separate people');
});

test('three different Ahmed Saids are NOT merged', () => {
  const cs = cluster('said-a');
  const ahmeds = withFore(cs, 'Ahmed').filter((c) => c.n >= 3);
  assert.ok(ahmeds.length >= 2, `expected several distinct Ahmed Saids, got ${ahmeds.length}`);
  const orcids = new Set(ahmeds.map((c) => c.orcid).filter(Boolean));
  assert.ok(orcids.size >= 2, 'distinct Ahmed Said ORCIDs collapsed together');
});

test('a common surname does not collapse into a few people', () => {
  // "Shah N" returns 9846 records across a great many real people. Aggressive
  // merging here would be catastrophic, so rarity-based merging must not fire.
  const cs = cluster('shah-n');
  assert.ok(cs.length >= 50, `Shah N collapsed to ${cs.length} people, which is wrong`);
  const biggest = cs[0].n;
  assert.ok(biggest < 30, `one Shah cluster swallowed ${biggest} records`);
});

test('no cluster ever contains two different ORCIDs', () => {
  // The invariant that makes a wrong merge detectable rather than silent.
  for (const slug of Object.keys(TOTALS)) {
    for (const c of cluster(slug)) {
      const recs = load(slug).filter((r: any) => c.pmids.includes(r.pmid));
      const orcids = new Set(recs.map((r: any) => r.orcid).filter(Boolean));
      assert.ok(orcids.size <= 1, `${slug}: a cluster mixes ORCIDs ${[...orcids].join(', ')}`);
    }
  }
});

// ------------------------------------------------------------- unit gates ----

test('the hard gate refuses conflicting forenames and ORCIDs', () => {
  assert.strictEqual(compatible({ fore: 'Amanda', orcid: '' }, { fore: 'Andrew', orcid: '' }), false);
  assert.strictEqual(compatible({ fore: 'Amanda', orcid: 'a' }, { fore: 'Amanda', orcid: 'b' }), false);
  assert.strictEqual(compatible({ fore: 'Amanda', orcid: '' }, { fore: 'A', orcid: '' }), true);
  assert.strictEqual(compatible({ fore: 'Amanda', orcid: '' }, { fore: 'R', orcid: '' }), false);
  assert.strictEqual(similarity({ fore: 'Amanda', orcid: 'x', _co: new Set(), _inst: '' },
                                { fore: 'Andrew', orcid: 'y', _co: new Set(), _inst: '' }), 0);
});

test('institution normalisation collapses one author\'s own variants', () => {
  const a = institutionKey('Department of Pediatrics, Washington University School of Medicine, St. Louis, MO.');
  const b = institutionKey('Division of Critical Care, Washington University in St. Louis, MO.');
  // Exact equality is the wrong bar: one author's own variants normalise to
  // "washington university" and "washington university st louis".
  assert.ok(sameInstitution(a, b), `"${a}" and "${b}" should be the same institution`);
  assert.ok(!sameInstitution(institutionKey('Duke University Medical Center'), a),
    'Duke and Washington University must not match');
  assert.ok(!sameInstitution(institutionKey('University of Michigan'), a));
  assert.ok(!institutionKey("Saint Louis Children's Hospital").includes(' s '),
    'apostrophes must not split a word into a stray letter');
});

test('rarity gates forename-only merging', () => {
  // The rarity rule says: on a rare surname, two records with a compatible
  // forename are almost certainly one person. On a common one that inference is
  // worthless, and applying it anyway would merge strangers. Neither real
  // fixture exercised the dangerous half, because the people who share a full
  // forename there also carry different ORCIDs, which the hard gate already
  // blocks. This constructs the case with no ORCID to lean on.
  const twoPeople = [
    { pmid: '1', last: 'Smith', fore: 'John', orcid: '', aff: 'Department of Medicine, Alpha University',
      journal: 'J A', year: '2024', title: 'A', coauthors: ['Alvarez P', 'Chen L'], mesh: [] },
    { pmid: '2', last: 'Smith', fore: 'John', orcid: '', aff: 'Department of Surgery, Beta Hospital',
      journal: 'J B', year: '2024', title: 'B', coauthors: ['Okafor N', 'Rossi G'], mesh: [] },
  ];
  const common = clusterAuthors(twoPeople, { totalForName: 5000 });
  assert.strictEqual(common.length, 2,
    'a common name merged two people on nothing but a shared forename');

  const rare = clusterAuthors(twoPeople, { totalForName: 12 });
  assert.strictEqual(rare.length, 1,
    'a rare name should merge compatible records; that is the whole point of the rule');
});

test('shared co-authors merge, and their absence does not', () => {
  const base = { last: 'Nguyen', fore: 'Mai', orcid: '', journal: 'J', year: '2024', title: 't', mesh: [] };
  const linked = clusterAuthors([
    { ...base, pmid: '1', aff: 'Alpha University', coauthors: ['Okafor N', 'Rossi G', 'Chen L'] },
    { ...base, pmid: '2', aff: 'Beta Institute',   coauthors: ['Okafor N', 'Rossi G', 'Silva M'] },
  ], { totalForName: 5000 });
  assert.strictEqual(linked.length, 1, 'two shared co-authors should be enough to merge');

  const unlinked = clusterAuthors([
    { ...base, pmid: '1', aff: 'Alpha University', coauthors: ['Okafor N', 'Rossi G'] },
    { ...base, pmid: '2', aff: 'Beta Institute',   coauthors: ['Silva M', 'Haddad Y'] },
  ], { totalForName: 5000 });
  assert.strictEqual(unlinked.length, 2, 'no shared co-authors and no shared institution should not merge');
});
