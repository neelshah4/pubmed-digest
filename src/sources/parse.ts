// Hand-rolled PubMed EFetch XML parser. No XML library — Node builtins only.
// Never throws on a single malformed <PubmedArticle> record: it is skipped and counted.

import type { Paper, Author } from '../types.ts';

const MONTHS: Record<string, string> = {
  jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
  jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
};

interface TagMatch {
  attrs: string;
  content: string;
}

function extractFirst(xml: string, tag: string): string | undefined {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'i');
  const m = xml.match(re);
  return m ? m[1] : undefined;
}

function extractAll(xml: string, tag: string): TagMatch[] {
  const re = new RegExp(`<${tag}((?:\\s[^>]*)?)>([\\s\\S]*?)</${tag}>`, 'gi');
  const results: TagMatch[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    results.push({ attrs: m[1] ?? '', content: m[2] });
  }
  return results;
}

function extractAttr(attrsStr: string, name: string): string | undefined {
  const re = new RegExp(`${name}\\s*=\\s*"([^"]*)"`, 'i');
  const m = attrsStr.match(re);
  return m ? m[1] : undefined;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_m, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&amp;/g, '&');
}

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, '');
}

function cleanText(s: string | undefined | null): string {
  if (!s) return '';
  return decodeEntities(stripTags(s)).replace(/\s+/g, ' ').trim();
}

function pad2(raw: string): string {
  const n = parseInt(raw, 10);
  if (Number.isNaN(n)) return '01';
  return String(n).padStart(2, '0');
}

function monthToNum(raw: string): string {
  const trimmed = raw.trim();
  if (/^\d+$/.test(trimmed)) return pad2(trimmed);
  const key = trimmed.slice(0, 3).toLowerCase();
  return MONTHS[key] ?? '01';
}

/** Parses a Year/Month/Day (or MedlineDate fallback) block into YYYY-MM-DD. Returns '' if unparseable. */
function parseYMD(block: string): string {
  const yearRaw = extractFirst(block, 'Year');
  if (yearRaw) {
    const year = cleanText(yearRaw);
    if (!/^\d{4}$/.test(year)) return '';
    const monthRaw = extractFirst(block, 'Month');
    const dayRaw = extractFirst(block, 'Day');
    const month = monthRaw ? monthToNum(cleanText(monthRaw)) : '01';
    const day = dayRaw ? pad2(cleanText(dayRaw)) : '01';
    return `${year}-${month}-${day}`;
  }

  const medlineRaw = extractFirst(block, 'MedlineDate');
  if (medlineRaw) {
    const medline = cleanText(medlineRaw);
    const yearMatch = medline.match(/\d{4}/);
    if (!yearMatch) return '';
    const monthMatch = medline.match(/\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\b/i);
    const month = monthMatch ? monthToNum(monthMatch[0]) : '01';
    return `${yearMatch[0]}-${month}-01`;
  }

  return '';
}

function parseEdat(xml: string): string {
  const historyRaw = extractFirst(xml, 'History') ?? '';
  const entries = extractAll(historyRaw, 'PubMedPubDate');
  for (const e of entries) {
    const status = extractAttr(e.attrs, 'PubStatus');
    if (status && status.toLowerCase() === 'entrez') {
      const d = parseYMD(e.content);
      if (d) return d;
    }
  }
  return '';
}

function parsePubDate(xml: string): string {
  const journalRaw = extractFirst(xml, 'Journal') ?? '';
  const issueRaw = extractFirst(journalRaw, 'JournalIssue') ?? journalRaw;
  const pubDateRaw = extractFirst(issueRaw, 'PubDate');
  if (pubDateRaw) {
    const d = parseYMD(pubDateRaw);
    if (d) return d;
  }
  // Fallback: ArticleDate (electronic pub date) sometimes present when JournalIssue/PubDate is sparse.
  const articleDateRaw = extractFirst(xml, 'ArticleDate');
  if (articleDateRaw) {
    const d = parseYMD(articleDateRaw);
    if (d) return d;
  }
  return '';
}

function parseAbstract(xml: string): string {
  const abstractBlockRaw = extractFirst(xml, 'Abstract');
  if (!abstractBlockRaw) return '';
  const texts = extractAll(abstractBlockRaw, 'AbstractText');
  const parts: string[] = [];
  for (const t of texts) {
    const label = extractAttr(t.attrs, 'Label');
    const text = cleanText(t.content);
    if (!text) continue;
    parts.push(label ? `${label}: ${text}` : text);
  }
  return parts.join('\n\n');
}

function parseAuthors(xml: string): Author[] {
  const authorListRaw = extractFirst(xml, 'AuthorList') ?? '';
  if (!authorListRaw) return [];
  const authorBlocks = extractAll(authorListRaw, 'Author');
  const authors: Author[] = [];

  for (const a of authorBlocks) {
    const lastName = cleanText(extractFirst(a.content, 'LastName'));
    const collective = cleanText(extractFirst(a.content, 'CollectiveName'));
    const last = lastName || collective;
    const fore = cleanText(extractFirst(a.content, 'ForeName'));
    if (!last && !fore) continue;

    const affilInfos = extractAll(a.content, 'AffiliationInfo');
    const affilTexts: string[] = [];
    for (const ai of affilInfos) {
      const aff = cleanText(extractFirst(ai.content, 'Affiliation'));
      if (aff) affilTexts.push(aff);
    }
    const affiliation = affilTexts.length ? affilTexts.join('; ') : undefined;

    let orcid: string | undefined;
    const identifiers = extractAll(a.content, 'Identifier');
    for (const idBlock of identifiers) {
      const source = extractAttr(idBlock.attrs, 'Source');
      if (source && source.toUpperCase() === 'ORCID') {
        orcid = cleanText(idBlock.content).replace(/^https?:\/\/orcid\.org\//i, '');
        break;
      }
    }

    const author: Author = { last, fore };
    if (orcid) author.orcid = orcid;
    if (affiliation) author.affiliation = affiliation;
    authors.push(author);
  }

  return authors;
}

function parseDoi(xml: string): string | undefined {
  const elocations = extractAll(xml, 'ELocationID');
  for (const el of elocations) {
    const eidType = extractAttr(el.attrs, 'EIdType');
    if (eidType && eidType.toLowerCase() === 'doi') {
      const doi = cleanText(el.content);
      if (doi) return doi;
    }
  }
  return undefined;
}

function parseOneArticle(xml: string): Paper | null {
  const pmid = cleanText(extractFirst(xml, 'PMID'));
  if (!pmid) return null;

  const title = cleanText(extractFirst(xml, 'ArticleTitle'));
  if (!title) return null;

  const journal = cleanText(extractFirst(xml, 'ISOAbbreviation'));
  if (!journal) return null;

  const edat = parseEdat(xml);
  const pubdate = parsePubDate(xml);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(edat) || !/^\d{4}-\d{2}-\d{2}$/.test(pubdate)) return null;

  const abstract = parseAbstract(xml);

  const pubTypes = extractAll(xml, 'PublicationType')
    .map((p) => cleanText(p.content))
    .filter(Boolean);

  const meshHeadingListRaw = extractFirst(xml, 'MeshHeadingList') ?? '';
  const descriptors = extractAll(meshHeadingListRaw, 'DescriptorName');
  const mesh: string[] = [];
  const meshMajor: string[] = [];
  for (const d of descriptors) {
    const name = cleanText(d.content);
    if (!name) continue;
    mesh.push(name);
    const major = extractAttr(d.attrs, 'MajorTopicYN');
    if (major && major.toUpperCase() === 'Y') meshMajor.push(name);
  }

  const authors = parseAuthors(xml);
  const doi = parseDoi(xml);
  const language = extractAll(xml, 'Language')
    .map((l) => cleanText(l.content))
    .filter(Boolean);

  const paper: Paper = {
    pmid,
    title,
    abstract,
    journal,
    pubTypes,
    mesh,
    meshMajor,
    authors,
    edat,
    pubdate,
    language,
  };
  if (doi) paper.doi = doi;
  return paper;
}

export function parsePubmedXml(xml: string): Paper[] {
  const re = /<PubmedArticle(?:\s[^>]*)?>([\s\S]*?)<\/PubmedArticle>/gi;
  const papers: Paper[] = [];
  let skipped = 0;
  let m: RegExpExecArray | null;

  while ((m = re.exec(xml)) !== null) {
    try {
      const paper = parseOneArticle(m[1]);
      if (paper) {
        papers.push(paper);
      } else {
        skipped++;
      }
    } catch {
      skipped++;
    }
  }

  parsePubmedXml.lastSkipped = skipped;
  return papers;
}
parsePubmedXml.lastSkipped = 0;
