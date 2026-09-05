/**
 * Turns the rendered body of a GitHub Issue Form submission (created from
 * .github/ISSUE_TEMPLATE/subscribe.yml) into a validated SignupPrefs object.
 *
 * Why this exists as its own module rather than bash/YAML in the workflow:
 * the parsing and validation logic is exactly the kind of thing that is easy
 * to get subtly wrong in a shell script and hard to unit-test there. This
 * file is plain TS with zero Node-only APIs beyond what's already used
 * elsewhere in src/, so tests/signup.test.ts can exercise it directly.
 *
 * GitHub renders each Issue Form field into the issue body as:
 *   ### <label>
 *
 *   <value, or literally "_No response_" if the field was left empty>
 *
 * confirmed against a live rendered issue this session (2026-09-05):
 * https://api.github.com/repos/iptv-org/database/issues/32990 — an optional
 * `input`/`textarea` field left blank renders as "### <label>\n\n_No
 * response_\n\n". A `checkboxes` field's checked options render as a
 * markdown task-list item per option; confirmed against a real submission of
 * vitejs/vite's own Issue Form (which uses `type: checkboxes`):
 * https://api.github.com/repos/vitejs/vite/issues/23430 — each checked box
 * appears as "- [x] <option label>". This parser only looks for the
 * "[x]"/"[X]" marker, so it does not depend on whether unchecked options are
 * omitted entirely or rendered as "- [ ] <option label>" — both read the
 * same way here.
 *
 * The exact `label:` text of every field below MUST match
 * .github/ISSUE_TEMPLATE/subscribe.yml verbatim — that is the only contract
 * between the two files. See FIELD_LABELS.
 *
 * Field-schema reference (GitHub's own docs, fetched this session):
 * https://docs.github.com/en/communities/using-templates-to-encourage-useful-issues-and-pull-requests/syntax-for-issue-forms
 */
import { listTemplates } from './config.ts';
import { ORCID_RE } from './sources/eutils.ts';
import type { AuthorWatch, SignupPrefs } from './types.ts';

/** Must match the `label:` attribute of the corresponding field in subscribe.yml exactly. */
export const FIELD_LABELS = {
  email: 'Email address',
  cadence: 'Cadence',
  templates: 'Specialty templates',
  journalTier: 'Journal tier',
  pubTypes: 'Publication types',
  extraKeywords: 'Extra keywords',
  orcidList: 'Author ORCID watch list',
} as const;

const CADENCE_VALUES = ['weekly', 'monthly'] as const;
const JOURNAL_TIER_VALUES = ['tier1', 'tier12', 'all'] as const;

// RFC-ish, not RFC 5322: rejects the obviously-wrong shapes (no "@", no dot in
// the domain, embedded whitespace) without trying to be a full mail-address
// parser. Good enough for "did the subscriber typo their address."
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type ParseResult =
  | { ok: true; prefs: SignupPrefs }
  | { ok: false; errors: string[] };

/** Escape a string for use inside a RegExp — Node has no built-in for this. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Pull the text GitHub rendered under "### <label>" up to the next "### " (or
 * end of body). Returns '' for a missing section OR a literal "_No response_"
 * — both mean "the subscriber left this field empty" from the parser's point
 * of view, and callers decide whether that's an error.
 */
function extractSection(body: string, label: string): string {
  const headerRe = new RegExp(`^###\\s+${escapeRegExp(label)}\\s*$`, 'm');
  const match = headerRe.exec(body);
  if (!match) return '';
  const rest = body.slice(match.index + match[0].length);
  const nextHeader = /^###\s+/m.exec(rest);
  const chunk = (nextHeader ? rest.slice(0, nextHeader.index) : rest).trim();
  return chunk === '_No response_' ? '' : chunk;
}

/** Every "- [x] <text>" / "- [X] <text>" line in a checkboxes field's rendered chunk. */
function extractChecked(chunk: string): string[] {
  const out: string[] = [];
  for (const line of chunk.split('\n')) {
    const m = /^-\s*\[[xX]\]\s*(.+?)\s*$/.exec(line);
    if (m) out.push(m[1]);
  }
  return out;
}

export function parseIssueBody(body: string): ParseResult {
  const errors: string[] = [];
  const src = body ?? '';

  // --- email ---------------------------------------------------------------
  const email = extractSection(src, FIELD_LABELS.email);
  if (!email) {
    errors.push(`Missing required field "${FIELD_LABELS.email}".`);
  } else if (!EMAIL_RE.test(email)) {
    errors.push(`"${email}" is not a valid email address.`);
  }

  // --- cadence ---------------------------------------------------------------
  const cadenceRaw = extractSection(src, FIELD_LABELS.cadence).toLowerCase();
  if (!cadenceRaw) {
    errors.push(`Missing required field "${FIELD_LABELS.cadence}".`);
  } else if (!(CADENCE_VALUES as readonly string[]).includes(cadenceRaw)) {
    errors.push(`Cadence "${cadenceRaw}" must be one of: ${CADENCE_VALUES.join(', ')}.`);
  }

  // --- templates ---------------------------------------------------------------
  // Each checkbox option's label IS the template slug (see subscribe.yml) so
  // there is no separate display-name-to-slug mapping to keep in sync.
  const templateChunk = extractSection(src, FIELD_LABELS.templates);
  const templates = extractChecked(templateChunk);
  const knownTemplates = listTemplates();
  if (templates.length === 0) {
    errors.push('Choose at least one specialty template.');
  }
  for (const t of templates) {
    if (!knownTemplates.includes(t)) {
      errors.push(`Unknown template "${t}". Available: ${knownTemplates.join(', ')}.`);
    }
  }

  // --- journal tier ---------------------------------------------------------------
  const journalTierRaw = extractSection(src, FIELD_LABELS.journalTier).toLowerCase();
  if (!journalTierRaw) {
    errors.push(`Missing required field "${FIELD_LABELS.journalTier}".`);
  } else if (!(JOURNAL_TIER_VALUES as readonly string[]).includes(journalTierRaw)) {
    errors.push(`Journal tier "${journalTierRaw}" must be one of: ${JOURNAL_TIER_VALUES.join(', ')}.`);
  }

  // --- publication types ---------------------------------------------------------------
  // Optional. Raw checkbox text is passed through as-is (see subscribe.yml —
  // these mirror web/index.html's pubTypes checkbox values so both intake
  // paths produce identical SignupPrefs.pubTypes strings). Not validated
  // against a fixed set here: the contract for this parser only requires
  // validating email, ORCID format, and template slugs.
  const pubTypes = extractChecked(extractSection(src, FIELD_LABELS.pubTypes));

  // --- extra keywords ---------------------------------------------------------------
  const extraKeywordsRaw = extractSection(src, FIELD_LABELS.extraKeywords);
  const extraKeywords = extraKeywordsRaw
    ? extraKeywordsRaw.split(',').map((s) => s.trim()).filter(Boolean)
    : [];

  // --- ORCID watch list ---------------------------------------------------------------
  // One ORCID per line, optionally followed by whitespace and a free-text
  // label (never trusted for matching — see AuthorWatch.label). Blank lines
  // ignored.
  const authors: AuthorWatch[] = [];
  const orcidChunk = extractSection(src, FIELD_LABELS.orcidList);
  for (const rawLine of orcidChunk.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    const sp = line.search(/\s/);
    const orcidToken = (sp === -1 ? line : line.slice(0, sp)).toUpperCase();
    const label = sp === -1 ? undefined : line.slice(sp + 1).trim() || undefined;
    if (!ORCID_RE.test(orcidToken)) {
      errors.push(`"${orcidToken}" is not a valid ORCID iD (expected 0000-0000-0000-000X).`);
      continue;
    }
    authors.push(label ? { orcid: orcidToken, label } : { orcid: orcidToken });
  }

  if (errors.length > 0) return { ok: false, errors };

  return {
    ok: true,
    prefs: {
      email,
      cadence: cadenceRaw as SignupPrefs['cadence'],
      templates,
      journalTier: journalTierRaw as SignupPrefs['journalTier'],
      pubTypes,
      extraKeywords,
      authors,
    },
  };
}
