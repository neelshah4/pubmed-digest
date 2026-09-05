// Live NCBI E-utilities client. No mocks, no fixtures at runtime — every call hits
// https://eutils.ncbi.nlm.nih.gov. Fails loudly (throws) rather than returning [] on error.

import type { Paper } from '../types.ts';
import { parsePubmedXml } from './parse.ts';

export interface FetchOpts {
  journals: string[];
  days: number;
  apiKey?: string;
  tool?: string;
  email?: string;
  retmax?: number;
}

const ESEARCH_URL = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi';
const EFETCH_URL = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi';
const EFETCH_BATCH_SIZE = 200;
const DEFAULT_RETMAX = 500;
const DEFAULT_TOOL = 'pubmed-digest';

const MAX_ATTEMPTS = 3;
const BACKOFF_MS = [1000, 2000, 4000];
// NCBI etiquette requires tool+email on every call. Generic, non-personal default so this
// library doesn't ship with one operator's personal address baked in — callers running a real
// pipeline should pass their own contact via FetchOpts.email.
const DEFAULT_EMAIL = 'pubmed-digest@example.com';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function rateLimitDelay(apiKey?: string): number {
  // NCBI: 3 req/s without a key, 10 req/s with one. Stay comfortably under.
  return apiKey ? 110 : 350;
}

function buildTerm(journals: string[]): string {
  return journals.map((j) => `"${j}"[ta]`).join(' OR ');
}

function commonParams(o: Partial<FetchOpts>): URLSearchParams {
  const params = new URLSearchParams();
  params.set('tool', o.tool ?? DEFAULT_TOOL);
  params.set('email', o.email ?? DEFAULT_EMAIL);
  if (o.apiKey) params.set('api_key', o.apiKey);
  return params;
}

async function postWithRetry(url: string, body: URLSearchParams, apiKey?: string): Promise<string> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      });
    } catch (err) {
      lastErr = err;
      if (attempt < MAX_ATTEMPTS) {
        await sleep(BACKOFF_MS[attempt - 1]);
        continue;
      }
      throw new Error(
        `eutils: network failure calling ${url} after ${MAX_ATTEMPTS} attempts: ${(err as Error).message}`
      );
    }

    if (res.ok) {
      const text = await res.text();
      await sleep(rateLimitDelay(apiKey));
      return text;
    }

    if ((res.status === 429 || res.status >= 500) && attempt < MAX_ATTEMPTS) {
      lastErr = new Error(`HTTP ${res.status}`);
      await sleep(BACKOFF_MS[attempt - 1]);
      continue;
    }

    const bodyText = await res.text().catch(() => '<unreadable body>');
    throw new Error(
      `eutils: ${url} returned HTTP ${res.status} ${res.statusText} after ${attempt} attempt(s). Body: ${bodyText.slice(0, 500)}`
    );
  }
  throw new Error(`eutils: exhausted ${MAX_ATTEMPTS} attempts calling ${url}: ${(lastErr as Error)?.message ?? lastErr}`);
}

export async function searchUnion(o: FetchOpts): Promise<string[]> {
  if (!o.journals || o.journals.length === 0) {
    throw new Error('eutils.searchUnion: journals list is empty');
  }
  const term = buildTerm(o.journals);
  const params = commonParams(o);
  params.set('db', 'pubmed');
  params.set('retmode', 'json');
  params.set('datetype', 'edat');
  params.set('reldate', String(o.days));
  params.set('retmax', String(o.retmax ?? DEFAULT_RETMAX));
  params.set('term', term);

  const text = await postWithRetry(ESEARCH_URL, params, o.apiKey);

  let json: any;
  try {
    json = JSON.parse(text);
  } catch (err) {
    throw new Error(`eutils.searchUnion: esearch returned non-JSON response: ${text.slice(0, 500)}`);
  }

  const idlist = json?.esearchresult?.idlist;
  if (!Array.isArray(idlist)) {
    const errList = json?.esearchresult?.errorlist;
    throw new Error(
      `eutils.searchUnion: esearch response missing idlist. errorlist=${JSON.stringify(errList)} raw=${text.slice(0, 500)}`
    );
  }
  return idlist as string[];
}

export async function fetchPapers(pmids: string[], o: Partial<FetchOpts> = {}): Promise<Paper[]> {
  if (pmids.length === 0) return [];

  const papers: Paper[] = [];
  let totalSkipped = 0;

  for (let i = 0; i < pmids.length; i += EFETCH_BATCH_SIZE) {
    const batch = pmids.slice(i, i + EFETCH_BATCH_SIZE);
    const params = commonParams(o);
    params.set('db', 'pubmed');
    params.set('retmode', 'xml');
    params.set('id', batch.join(','));

    const xml = await postWithRetry(EFETCH_URL, params, o.apiKey);
    const parsed = parsePubmedXml(xml);
    totalSkipped += parsePubmedXml.lastSkipped;
    papers.push(...parsed);
  }

  fetchPapers.lastSkipped = totalSkipped;
  return papers;
}
fetchPapers.lastSkipped = 0;

export async function harvest(o: FetchOpts): Promise<Paper[]> {
  const pmids = await searchUnion(o);
  return fetchPapers(pmids, o);
}

// ---------------------------------------------------------------------------
// Author watching
// ---------------------------------------------------------------------------

/** ORCID iD, bare form. Anything else is rejected rather than guessed at. */
export const ORCID_RE = /^\d{4}-\d{4}-\d{4}-\d{3}[0-9X]$/;

/**
 * PMIDs for one followed author, in the last `days`.
 *
 * ORCID only. PubMed's plain author search ("Smith J[au]") collides across
 * everyone sharing a surname and initial, and surfacing the wrong person's
 * papers is worse than not offering the feature. The [auid] tag was verified
 * against live E-utilities: 0000-0002-1825-0097[auid] returns records cleanly.
 * https://pubmed.ncbi.nlm.nih.gov/help/
 */
export async function searchAuthor(orcid: string, o: Partial<FetchOpts> = {}): Promise<string[]> {
  if (!ORCID_RE.test(orcid)) throw new Error(`Not a valid ORCID iD: "${orcid}"`);
  const params = commonParams(o);
  params.set('term', `${orcid}[auid]`);
  params.set('retmode', 'json');
  params.set('datetype', 'edat');
  params.set('reldate', String(o.days ?? 7));
  params.set('retmax', String(o.retmax ?? 200));
  const raw = await postWithRetry('https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi', params, o.apiKey);
  try {
    return JSON.parse(raw)?.esearchresult?.idlist ?? [];
  } catch {
    throw new Error(`ESearch returned unparseable JSON for ORCID ${orcid}`);
  }
}

/**
 * PMIDs for every followed author, keyed by ORCID.
 *
 * Sequential with the standard rate-limit delay. One author's failure must not
 * lose the others, so failures are reported per-ORCID rather than thrown.
 */
export async function searchAuthors(
  orcids: string[],
  o: Partial<FetchOpts> = {},
): Promise<{ byOrcid: Map<string, string[]>; failed: { orcid: string; error: string }[] }> {
  const byOrcid = new Map<string, string[]>();
  const failed: { orcid: string; error: string }[] = [];
  for (const id of [...new Set(orcids)]) {
    try {
      byOrcid.set(id, await searchAuthor(id, o));
    } catch (e) {
      failed.push({ orcid: id, error: e instanceof Error ? e.message : String(e) });
    }
    await sleep(rateLimitDelay(o.apiKey));
  }
  return { byOrcid, failed };
}
