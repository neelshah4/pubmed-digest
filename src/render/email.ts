/**
 * Email rendering for a Digest: table-based HTML (email-client safe), a plain-text
 * fallback, and the subject line. No external CSS/JS/fonts/images — every style is
 * inlined because most mail clients strip <style> blocks and none run a real browser
 * layout engine. Colors are chosen to stay legible if a client (Apple Mail, Outlook.com)
 * naively inverts them for dark mode: no pure black/white extremes, and every colored
 * cell sets its background explicitly via both `style` and the legacy `bgcolor`
 * attribute so Outlook's Word engine honors it too.
 */
import type { Digest, ScoredPaper } from '../types.ts';

// Single-quoted "Segoe UI": this string is spliced into double-quoted style="..." attributes,
// so a literal `"` here would terminate the attribute early and corrupt every element after it.
const FONT = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";
const WIDTH = 600;

// ---------------------------------------------------------------------------
// Escaping / text helpers
// ---------------------------------------------------------------------------

/** Escape text for safe placement in HTML body text OR an HTML attribute value. */
export function esc(s: string): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Truncate to at most maxLen chars, ending on a word boundary, plus an ellipsis. */
export function snippet(text: string, maxLen = 220): string {
  const t = (text ?? '').trim();
  if (t.length <= maxLen) return t;
  const cut = t.slice(0, maxLen);
  const lastSpace = cut.lastIndexOf(' ');
  const safe = (lastSpace > 40 ? cut.slice(0, lastSpace) : cut).trimEnd();
  return `${safe}…`; // …
}

function pubmedUrl(pmid: string): string {
  return `https://pubmed.ncbi.nlm.nih.gov/${encodeURIComponent(pmid)}/`;
}

/** Append/replace query params on a URL. Falls back to string concat if `base` isn't parseable. */
function withQuery(base: string, params: Record<string, string>): string {
  try {
    const u = new URL(base);
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
    return u.toString();
  } catch {
    const qs = Object.entries(params).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
    return base + (base.includes('?') ? '&' : '?') + qs;
  }
}

function feedbackUrl(feedbackBaseUrl: string, pmid: string, tag: 'star' | 'tilde' | 'skip', userId: string): string {
  return withQuery(feedbackBaseUrl, { pmid, tag, u: userId });
}

/** "Respiratory_ARDS" -> "Respiratory ARDS". Section names come from WatcherConfig keys. */
function prettySection(name: string): string {
  return name.replace(/_/g, ' ');
}

/** First pubType that isn't the generic "Journal Article", else the first entry, else a fallback. */
function primaryStudyType(pubTypes: string[]): string {
  const notable = (pubTypes ?? []).filter((t) => t !== 'Journal Article');
  return notable[0] ?? pubTypes?.[0] ?? 'Study';
}

function formatDateRange(generatedAtIso: string, windowDays: number): string {
  const end = new Date(generatedAtIso);
  const start = new Date(end.getTime() - windowDays * 24 * 60 * 60 * 1000);
  const md = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' });
  const y = new Intl.DateTimeFormat('en-US', { year: 'numeric' });
  const sameYear = start.getFullYear() === end.getFullYear();
  const startStr = sameYear ? md.format(start) : `${md.format(start)}, ${y.format(start)}`;
  return `${startStr} – ${md.format(end)}, ${y.format(end)}`;
}

// ---------------------------------------------------------------------------
// Subject
// ---------------------------------------------------------------------------

export function renderSubject(d: Digest): string {
  const range = formatDateRange(d.generatedAt, d.windowDays);
  const prefix = d.practiceChanging.length > 0 ? '⚡ ' : '';
  return `${prefix}Critical Care Digest: ${range} (${d.totalAfterFilter} kept)`;
}

// ---------------------------------------------------------------------------
// HTML rendering
// ---------------------------------------------------------------------------

type Variant = 'practiceChanging' | 'normal' | 'borderline';

const BADGE_STYLE: Record<Variant, string> = {
  practiceChanging: 'background-color:#fef3c7;color:#92400e;',
  normal: 'background-color:#e8edfb;color:#1d3f8f;',
  borderline: 'background-color:#eeeeee;color:#666666;',
};

const TITLE_COLOR: Record<Variant, string> = {
  practiceChanging: '#7a4a00',
  normal: '#0b3d91',
  borderline: '#444444',
};

function renderPaper(sp: ScoredPaper, opts: { feedbackBaseUrl: string; userId: string }, variant: Variant): string {
  const p = sp.paper;
  const url = esc(pubmedUrl(p.pmid));
  const titleSize = variant === 'borderline' ? 14 : 15;
  const badge = `<span style="display:inline-block;padding:2px 8px;border-radius:9px;font-size:11px;font-weight:600;${BADGE_STYLE[variant]}">Score ${sp.score.toFixed(1)}</span>`;
  const metaLine = `<span style="font-style:italic;color:#666666;">${esc(p.journal)}</span> &middot; ${esc(primaryStudyType(p.pubTypes))} &middot; ${badge}`;
  const abstractRow = p.abstract
    ? `<tr><td style="padding-top:6px;font-family:${FONT};font-size:13px;line-height:19px;color:#444444;">${esc(snippet(p.abstract))}</td></tr>`
    : '';

  const starUrl = esc(feedbackUrl(opts.feedbackBaseUrl, p.pmid, 'star', opts.userId));
  const tildeUrl = esc(feedbackUrl(opts.feedbackBaseUrl, p.pmid, 'tilde', opts.userId));
  const skipUrl = esc(feedbackUrl(opts.feedbackBaseUrl, p.pmid, 'skip', opts.userId));
  const feedbackRow = `
    <tr><td style="padding-top:8px;font-family:${FONT};font-size:11px;color:#9a9a9a;">
      <a href="${starUrl}" style="color:#9a9a9a;text-decoration:none;">&#9733; useful</a>
      &nbsp;&middot;&nbsp;
      <a href="${tildeUrl}" style="color:#9a9a9a;text-decoration:none;">~ maybe</a>
      &nbsp;&middot;&nbsp;
      <a href="${skipUrl}" style="color:#9a9a9a;text-decoration:none;">skip similar</a>
    </td></tr>`;

  return `
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:14px;">
    <tr><td style="font-family:${FONT};font-size:${titleSize}px;line-height:20px;">
      <a href="${url}" style="color:${TITLE_COLOR[variant]};text-decoration:none;font-weight:600;">${esc(p.title)}</a>
    </td></tr>
    <tr><td style="padding-top:3px;font-family:${FONT};font-size:12px;line-height:17px;">${metaLine}</td></tr>
    ${abstractRow}
    ${feedbackRow}
  </table>`;
}

function renderSectionBlock(name: string, papers: ScoredPaper[], opts: { feedbackBaseUrl: string; userId: string }): string {
  if (papers.length === 0) return '';
  const rows = papers.map((sp) => renderPaper(sp, opts, 'normal')).join('');
  return `
  <tr><td style="padding:22px 32px 0 32px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
      <tr><td style="font-family:${FONT};font-size:15px;font-weight:700;color:#111111;border-bottom:2px solid #e5e5e5;padding-bottom:6px;">${esc(prettySection(name))}</td></tr>
      <tr><td>${rows}</td></tr>
    </table>
  </td></tr>`;
}

function renderPracticeChanging(papers: ScoredPaper[], opts: { feedbackBaseUrl: string; userId: string }): string {
  if (papers.length === 0) return '';
  const rows = papers.map((sp) => renderPaper(sp, opts, 'practiceChanging')).join('');
  return `
  <tr><td style="padding:22px 32px 0 32px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#fffbeb;" bgcolor="#fffbeb">
      <tr>
        <td width="4" style="background-color:#f59e0b;font-size:0;line-height:0;" bgcolor="#f59e0b">&nbsp;</td>
        <td style="padding:16px 18px;">
          <div style="font-family:${FONT};font-size:14px;font-weight:700;color:#7a4a00;text-transform:uppercase;letter-spacing:0.03em;">&#9889; Practice-changing</div>
          ${rows}
        </td>
      </tr>
    </table>
  </td></tr>`;
}


/**
 * Papers surfaced because the reader follows the author, not because the journal
 * is on their whitelist. Rendered above the journal sections and labelled with
 * the author, so it is obvious why an off-whitelist journal is in the digest.
 */
function renderAuthorPapers(
  papers: ScoredPaper[],
  opts: { feedbackBaseUrl: string; userId: string },
): string {
  if (papers.length === 0) return '';
  const byAuthor = new Map<string, ScoredPaper[]>();
  for (const sp of papers) {
    const k = sp.authorMatch?.label || sp.authorMatch?.orcid || 'Followed author';
    byAuthor.set(k, [...(byAuthor.get(k) ?? []), sp]);
  }
  const groups = [...byAuthor.entries()].map(([who, ps]) => `
        <tr><td style="padding:2px 0 6px 0;font-family:${FONT};font-size:13px;font-weight:600;color:#3730a3;">
          ${esc(who)}
        </td></tr>
        ${ps.map((sp) => renderPaper(sp, opts, 'normal')).join('')}`).join('');

  return `
  <tr>
    <td style="padding:0 24px 8px 24px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
             style="border-left:4px solid #4f46e5;background-color:#eef2ff;">
        <tr><td style="padding:14px 16px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
            <tr><td style="padding:0 0 8px 0;font-family:${FONT};font-size:13px;font-weight:700;
                           letter-spacing:0.06em;text-transform:uppercase;color:#3730a3;">
              Authors you follow
            </td></tr>
            ${groups}
          </table>
        </td></tr>
      </table>
    </td>
  </tr>`;
}

function renderBorderline(papers: ScoredPaper[], opts: { feedbackBaseUrl: string; userId: string }): string {
  if (papers.length === 0) return '';
  const rows = papers.map((sp) => renderPaper(sp, opts, 'borderline')).join('');
  return `
  <tr><td style="padding:22px 32px 0 32px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#fafafa;" bgcolor="#fafafa">
      <tr><td style="padding:14px 18px;">
        <div style="font-family:${FONT};font-size:13px;font-weight:700;color:#888888;text-transform:uppercase;letter-spacing:0.03em;">Borderline</div>
        ${rows}
      </td></tr>
    </table>
  </td></tr>`;
}

export function renderDigestHtml(
  d: Digest,
  opts: { unsubscribeUrl: string; feedbackBaseUrl: string; userEmail: string },
): string {
  const inner = { feedbackBaseUrl: opts.feedbackBaseUrl, userId: d.userId };
  const dateRange = formatDateRange(d.generatedAt, d.windowDays);
  const authorCount = (d.authorPapers ?? []).length;
  const statLine = `${d.totalCandidates} papers screened, ${d.totalAfterFilter} kept`
    + (authorCount ? `, ${authorCount} from authors you follow` : '');

  const practiceChangingHtml = renderPracticeChanging(d.practiceChanging, inner);
  const authorHtml = renderAuthorPapers(d.authorPapers ?? [], inner);
  const sectionsHtml = d.sections.map((s) => renderSectionBlock(s.name, s.papers, inner)).join('');
  const borderlineHtml = renderBorderline(d.borderline, inner);

  const unsubUrl = esc(opts.unsubscribeUrl);

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="X-UA-Compatible" content="IE=edge">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<title>${esc(renderSubject(d))}</title>
</head>
<body style="margin:0;padding:0;background-color:#eef0f3;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#eef0f3;">
  <tr>
    <td align="center" style="padding:24px 12px;">
      <table role="presentation" width="${WIDTH}" cellpadding="0" cellspacing="0" border="0" style="width:${WIDTH}px;max-width:${WIDTH}px;background-color:#ffffff;" bgcolor="#ffffff">

        <tr><td style="background-color:#0b3d91;padding:26px 32px;" bgcolor="#0b3d91">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
            <tr><td style="font-family:${FONT};font-size:20px;font-weight:700;color:#ffffff;">Critical Care Literature Digest</td></tr>
            <tr><td style="padding-top:4px;font-family:${FONT};font-size:13px;color:#c9d9f7;">${esc(dateRange)}</td></tr>
            <tr><td style="padding-top:10px;font-family:${FONT};font-size:13px;color:#e3ecfc;">${esc(statLine)}</td></tr>
          </table>
        </td></tr>

        ${practiceChangingHtml}${authorHtml}
        ${sectionsHtml}
        ${borderlineHtml}

        <tr><td style="padding:26px 32px 28px 32px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-top:1px solid #e5e5e5;">
            <tr><td style="padding-top:16px;font-family:${FONT};font-size:11px;line-height:16px;color:#999999;">
              Courtesy of the U.S. National Library of Medicine.<br>
              This digest may not reflect NLM&#39;s most current data.<br>
              Sent to ${esc(opts.userEmail)}. &nbsp;<a href="${unsubUrl}" style="color:#999999;">Unsubscribe</a>
            </td></tr>
          </table>
        </td></tr>

      </table>
    </td>
  </tr>
</table>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Plain-text fallback
// ---------------------------------------------------------------------------

function textPaper(sp: ScoredPaper, feedbackBaseUrl: string, userId: string): string {
  const p = sp.paper;
  const lines = [
    `  - ${p.title}`,
    `    ${p.journal} | ${primaryStudyType(p.pubTypes)} | score ${sp.score.toFixed(1)}`,
    `    ${pubmedUrl(p.pmid)}`,
  ];
  if (p.abstract) lines.push(`    ${snippet(p.abstract)}`);
  lines.push(
    `    [useful] ${feedbackUrl(feedbackBaseUrl, p.pmid, 'star', userId)}`,
    `    [maybe]  ${feedbackUrl(feedbackBaseUrl, p.pmid, 'tilde', userId)}`,
    `    [skip]   ${feedbackUrl(feedbackBaseUrl, p.pmid, 'skip', userId)}`,
  );
  return lines.join('\n');
}

export function renderDigestText(
  d: Digest,
  opts: { unsubscribeUrl: string; feedbackBaseUrl: string; userEmail: string },
): string {
  const userId = d.userId;
  const out: string[] = [];
  out.push('CRITICAL CARE LITERATURE DIGEST');
  out.push(formatDateRange(d.generatedAt, d.windowDays));
  out.push(`${d.totalCandidates} papers screened, ${d.totalAfterFilter} kept`
    + ((d.authorPapers ?? []).length ? `, ${(d.authorPapers ?? []).length} from authors you follow` : ''));
  out.push('');

  if ((d.authorPapers ?? []).length > 0) {
    out.push('AUTHORS YOU FOLLOW');
    for (const sp of d.authorPapers) {
      out.push(`[via ${sp.authorMatch?.label ?? sp.authorMatch?.orcid ?? 'followed author'}]`);
      out.push(textPaper(sp, opts.feedbackBaseUrl, userId), '');
    }
  }

  if (d.practiceChanging.length > 0) {
    out.push('*** PRACTICE-CHANGING ***');
    for (const sp of d.practiceChanging) out.push(textPaper(sp, opts.feedbackBaseUrl, userId), '');
  }

  for (const s of d.sections) {
    if (s.papers.length === 0) continue;
    out.push(prettySection(s.name).toUpperCase());
    for (const sp of s.papers) out.push(textPaper(sp, opts.feedbackBaseUrl, userId), '');
  }

  if (d.borderline.length > 0) {
    out.push('BORDERLINE');
    for (const sp of d.borderline) out.push(textPaper(sp, opts.feedbackBaseUrl, userId), '');
  }

  out.push('---');
  out.push('Courtesy of the U.S. National Library of Medicine.');
  out.push("This digest may not reflect NLM's most current data.");
  out.push(`Sent to ${opts.userEmail}.`);
  out.push(`Unsubscribe: ${opts.unsubscribeUrl}`);

  return out.join('\n');
}
