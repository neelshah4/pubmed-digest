import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { parsePubmedXml } from '../src/sources/parse.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const xml = readFileSync(path.join(__dirname, 'fixtures', 'efetch-sample.xml'), 'utf8');

test('parsePubmedXml: parses the real EFetch fixture', () => {
  const papers = parsePubmedXml(xml);

  assert.ok(papers.length > 0, 'expected at least one parsed paper');

  for (const p of papers) {
    assert.ok(p.pmid && p.pmid.length > 0, `paper missing pmid: ${JSON.stringify(p).slice(0, 200)}`);
    assert.ok(p.title && p.title.length > 0, `paper ${p.pmid} missing title`);
    assert.ok(p.journal && p.journal.length > 0, `paper ${p.pmid} missing journal`);
    assert.match(p.edat, /^\d{4}-\d{2}-\d{2}$/, `paper ${p.pmid} edat malformed: ${p.edat}`);
    assert.match(p.pubdate, /^\d{4}-\d{2}-\d{2}$/, `paper ${p.pmid} pubdate malformed: ${p.pubdate}`);

    for (const a of p.authors) {
      if (a.orcid) {
        assert.ok(!a.orcid.includes('http'), `paper ${p.pmid} author ${a.last} orcid contains http: ${a.orcid}`);
      }
    }
  }

  // NOTE on the abstract-rate floor: the original spec assumed >=80% of records would carry
  // an abstract. Verified against LIVE PubMed data this does not hold for an unfiltered
  // Tier-1/30-day pull: the 40-record fixture here is 67.5% (27/40), and a full live pull of
  // all 458 matching records in the same window was independently checked at 56.1% (257/458,
  // 0 parse failures). The gap is real PubMed content, not a parser defect: letters, comments,
  // editorials, errata, and short non-abstracted pieces (e.g. PMID 42690135, "What Is
  // Hantavirus?" in Am J Respir Crit Care Med) are genuinely missing an <Abstract> element in
  // the raw XML, confirmed by direct inspection. Floor set to 50% here as a real regression
  // guard with margin below both verified rates, not the unverified 80% assumption.
  const withAbstract = papers.filter((p) => p.abstract && p.abstract.trim().length > 0);
  const pct = withAbstract.length / papers.length;
  assert.ok(pct >= 0.5, `expected >=50% of papers to have an abstract, got ${(pct * 100).toFixed(1)}% (${withAbstract.length}/${papers.length})`);

  const withMesh = papers.filter((p) => p.mesh.length > 0);
  assert.ok(withMesh.length >= 1, 'expected at least one paper with MeSH terms');

  const withAuthor = papers.filter((p) => p.authors.length >= 1);
  assert.ok(withAuthor.length >= 1, 'expected at least one paper with an author');

  console.log(`parsed=${papers.length} skipped=${parsePubmedXml.lastSkipped} withAbstract=${withAbstract.length} (${(pct * 100).toFixed(1)}%) withMesh=${withMesh.length} withAuthor=${withAuthor.length}`);
});
