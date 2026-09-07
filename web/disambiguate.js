/**
 * Author disambiguation for PubMed records.
 *
 * PubMed does not group authors, so one search returns a mix of people sharing a
 * surname and initial. Measured on real colleagues (tests/fixtures/authors):
 *   - "Said A" spans three different Ahmed Saids at Al-Azhar, KAUST and
 *     Washington University, so a forename match alone is NOT identity.
 *   - "Barbaro R" carries no affiliation at all on 70 of 110 records, so
 *     affiliation cannot be the primary key either.
 *   - The same people's papers share co-authors densely: 170 co-authors seen
 *     more than once for Barbaro, 144 for Raman, 37 for Kolmar.
 * Co-authorship is therefore the workhorse signal, ORCID is the certainty, and
 * affiliation and forename are supporting evidence and hard gates.
 *
 * Used by web/index.html and exercised by tests/disambiguate.test.ts against
 * fixtures captured from live PubMed.
 */

const STOP_INST = /\b(school of medicine|medical (school|center|centre)|health (system|sciences|care)|department|division|college of medicine|inc|llc)\b/g;

/** Institution, normalised so one author's variant spellings collapse together. */
export function institutionKey(aff) {
  if (!aff) return '';
  const clause = (aff.split(/[,;]/).map((x) => x.trim())
    .find((x) => /universit|hospital|college|institut|centre|center|clinic|school of medicine/i.test(x)) || '');
  return clause.toLowerCase()
    .replace(/['’]/g, '')
    .replace(STOP_INST, ' ')
    .replace(/\b(the|of|at|in|for|and)\b/g, ' ')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Do two normalised institution strings denote the same place?
 *
 * Exact equality is too strict: one author writes "Washington University School
 * of Medicine" and "Washington University in St. Louis", which normalise to
 * "washington university" and "washington university st louis". Containment
 * catches that. A shared-token ratio catches the rest. Abbreviations that do not
 * share a stem ("ut southwestern" against "university texas southwestern") are
 * deliberately left to co-authorship rather than guessed at here.
 */
export function sameInstitution(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  const A = new Set(a.split(' ').filter(Boolean));
  const B = new Set(b.split(' ').filter(Boolean));
  if (!A.size || !B.size) return false;
  const subset = [...A].every((t) => B.has(t)) || [...B].every((t) => A.has(t));
  if (subset) return true;
  let hit = 0;
  for (const t of A) if (B.has(t)) hit++;
  return hit / Math.min(A.size, B.size) >= 0.67;
}

const firstToken = (s) => (s || '').trim().split(/[\s.\-]+/)[0].toLowerCase();
const isInitialOnly = (s) => firstToken(s).length <= 1;

/**
 * Hard gate. Returns false when two records cannot be the same person no matter
 * what else agrees. Everything else is evidence; these two are disqualifying.
 */
export function compatible(a, b) {
  if (a.orcid && b.orcid && a.orcid !== b.orcid) return false;      // two ORCIDs is two people
  const fa = firstToken(a.fore), fb = firstToken(b.fore);
  if (!isInitialOnly(fa) && !isInitialOnly(fb) && fa !== fb) return false;  // Amanda is not Andrew
  if (fa && fb && (isInitialOnly(fa) || isInitialOnly(fb)) && fa[0] !== fb[0]) return false;
  return true;
}

const jaccardish = (A, B) => {
  if (!A.size || !B.size) return 0;
  let hit = 0;
  for (const x of A) if (B.has(x)) hit++;
  return hit / Math.min(A.size, B.size);
};

/** Similarity in [0,1]. A shared ORCID short-circuits to certainty. */
export function similarity(a, b) {
  if (!compatible(a, b)) return 0;
  if (a.orcid && b.orcid && a.orcid === b.orcid) return 1;

  const co = jaccardish(a._co, b._co);
  const instMatch = sameInstitution(a._inst, b._inst);
  const foreMatch = !isInitialOnly(a.fore) && !isInitialOnly(b.fore)
    && firstToken(a.fore) === firstToken(b.fore);
  const jrnMatch = a.journal && a.journal === b.journal;

  // Co-authorship dominates because it survives missing affiliations, which are
  // absent on most records for some authors.
  let s = 0.62 * Math.min(1, co * 2)      // one shared co-author out of a small list is meaningful
        + 0.22 * (instMatch ? 1 : 0)
        + 0.11 * (foreMatch ? 1 : 0)
        + 0.05 * (jrnMatch ? 1 : 0);

  // A full forename that matches, plus the same institution, is strong on its own
  // even with no co-author overlap (a solo paper, or a first-author-only index).
  if (foreMatch && instMatch) s = Math.max(s, 0.85);
  return Math.min(1, s);
}

class DSU {
  constructor(n) { this.p = [...Array(n).keys()]; }
  find(x) { while (this.p[x] !== x) { this.p[x] = this.p[this.p[x]]; x = this.p[x]; } return x; }
  union(a, b) { const ra = this.find(a), rb = this.find(b); if (ra !== rb) this.p[rb] = ra; }
}

/**
 * Clusters author instances into people.
 *
 * Merges any pair scoring at or above `threshold`, then refuses any cluster that
 * ended up holding two different ORCIDs or two different full forenames: single
 * linkage can otherwise chain two people together through a shared collaborator,
 * and a wrong merge is worse than a missed one because it silently pollutes an
 * alert with a stranger's work.
 */
export function clusterAuthors(records, { threshold = 0.8, totalForName = null } = {}) {
  const recs = records.map((r) => ({
    ...r,
    _co: new Set((r.coauthors || []).map((c) => c.toLowerCase())),
    _inst: institutionKey(r.aff),
  }));

  const dsu = new DSU(recs.length);
  for (let i = 0; i < recs.length; i++) {
    for (let j = i + 1; j < recs.length; j++) {
      if (similarity(recs[i], recs[j]) >= threshold) dsu.union(i, j);
    }
  }

  const byRoot = new Map();
  recs.forEach((r, i) => {
    const k = dsu.find(i);
    if (!byRoot.has(k)) byRoot.set(k, []);
    byRoot.get(k).push(r);
  });

  // Split any cluster that contradicts itself.
  const clusters = [];
  for (const members of byRoot.values()) {
    const orcids = new Set(members.map((m) => m.orcid).filter(Boolean));
    const fores = new Set(members.map((m) => firstToken(m.fore)).filter((f) => !isInitialOnly(f)));
    if (orcids.size > 1 || fores.size > 1) {
      const sub = new Map();
      for (const m of members) {
        const key = m.orcid || firstToken(m.fore) || '?';
        if (!sub.has(key)) sub.set(key, []);
        sub.get(key).push(m);
      }
      clusters.push(...sub.values());
    } else clusters.push(members);
  }

  // ---- second pass: agglomerate at the CLUSTER level ------------------------
  // A pair of individual papers often shares few co-authors even when the two
  // clusters they belong to share many. Measured on Barbaro R: the 97-paper
  // cluster shares 13, 12 and 11 co-authors with sub-clusters that no pairwise
  // score reached. Comparing whole clusters recovers them.
  //
  // How aggressive to be is scaled by how common the name is, which is knowable:
  // the same search returns 17 records for "Kolmar A", 155 for "Barbaro R" and
  // 9846 for "Shah N". On a rare name, two compatible records are almost
  // certainly one person; on a common one, that inference is worthless.
  const rare = totalForName !== null && totalForName <= 40;

  const coOf = (cl) => {
    const s = new Set();
    for (const m of cl) for (const c of m._co) s.add(c);
    return s;
  };
  const shared = (a, b) => { let n = 0; for (const x of a) if (b.has(x)) n++; return n; };

  let merged = true;
  while (merged) {
    merged = false;
    for (let i = 0; i < clusters.length && !merged; i++) {
      for (let j = i + 1; j < clusters.length && !merged; j++) {
        const A = clusters[i], B = clusters[j];
        const oa = new Set(A.map((m) => m.orcid).filter(Boolean));
        const ob = new Set(B.map((m) => m.orcid).filter(Boolean));
        if (oa.size && ob.size && ![...oa].some((o) => ob.has(o))) continue;   // different people
        const fa = new Set(A.map((m) => firstToken(m.fore)).filter((f) => !isInitialOnly(f)));
        const fb = new Set(B.map((m) => firstToken(m.fore)).filter((f) => !isInitialOnly(f)));
        if (fa.size && fb.size && ![...fa].some((f) => fb.has(f))) continue;   // Amanda is not Andrew
        const initA = [...new Set(A.map((m) => firstToken(m.fore)[0]).filter(Boolean))];
        const initB = [...new Set(B.map((m) => firstToken(m.fore)[0]).filter(Boolean))];
        if (initA.length && initB.length && !initA.some((x) => initB.includes(x))) continue;

        const sc = shared(coOf(A), coOf(B));
        const instA = new Set(A.map((m) => m._inst).filter(Boolean));
        const instB = new Set(B.map((m) => m._inst).filter(Boolean));
        const instMatch = [...instA].some((x) => [...instB].some((y) => sameInstitution(x, y)));
        const sameOrcid = oa.size && ob.size;
        const foreMatch = fa.size && fb.size;   // already known to intersect

        const link = sameOrcid || sc >= 2 || (sc >= 1 && instMatch) || (rare && foreMatch);
        if (link) { clusters[i] = A.concat(B); clusters.splice(j, 1); merged = true; }
      }
    }
  }

  return clusters
    .map((members) => {
      const orcid = members.map((m) => m.orcid).find(Boolean) || '';
      const fullFore = members.map((m) => m.fore).filter((f) => !isInitialOnly(f))
        .sort((a, b) => b.length - a.length)[0] || members[0].fore;
      const insts = [...new Set(members.map((m) => m._inst).filter(Boolean))];
      return {
        orcid,
        fore: fullFore,
        last: members[0].last,
        full: `${fullFore} ${members[0].last}`.trim(),
        insts,
        aff: members.map((m) => m.aff).find(Boolean) || '',
        n: members.length,
        pmids: members.map((m) => m.pmid),
        papers: members.slice(0, 3).map((m) => ({ title: m.title, journal: m.journal, year: m.year })),
      };
    })
    .sort((a, b) => b.n - a.n);
}

/**
 * How alike are two already-formed clusters, in [0,1]?
 *
 * clusterAuthors() has already merged everything it is confident about. What
 * survives is genuinely uncertain, and the reader is better placed to judge it
 * than any threshold. This scores the leftovers so the interface can say which
 * ones look related, without acting on that guess itself.
 */
export function clusterAffinity(a, b, records) {
  const recsOf = (c) => records.filter((r) => c.pmids.includes(r.pmid));
  const ra = recsOf(a), rb = recsOf(b);
  if (!ra.length || !rb.length) return 0;

  if (a.orcid && b.orcid) return a.orcid === b.orcid ? 1 : 0;

  const fa = (a.fore || '').trim().toLowerCase().split(/[\s.]+/)[0];
  const fb = (b.fore || '').trim().toLowerCase().split(/[\s.]+/)[0];
  const bothFull = fa.length > 1 && fb.length > 1;
  if (bothFull && fa !== fb) return 0;                 // Amanda is not Andrew
  if (fa && fb && fa[0] !== fb[0]) return 0;

  const co = (rs) => new Set(rs.flatMap((r) => (r.coauthors || []).map((c) => c.toLowerCase())));
  const A = co(ra), B = co(rb);
  let shared = 0;
  for (const x of A) if (B.has(x)) shared++;

  const instMatch = a.insts.some((x) => b.insts.some((y) => sameInstitution(x, y)));

  let s = 0;
  if (shared >= 3) s += 0.55;
  else if (shared === 2) s += 0.42;
  else if (shared === 1) s += 0.28;
  if (instMatch) s += 0.28;
  if (bothFull && fa === fb) s += 0.18;
  const jrn = new Set(ra.map((r) => r.journal));
  if (rb.some((r) => jrn.has(r.journal))) s += 0.08;
  return Math.min(1, s);
}
