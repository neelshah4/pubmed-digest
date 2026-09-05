/**
 * Supabase drop-in for src/state.ts. Same exported names, same shapes — every call goes over
 * PostgREST via global fetch (no SDK, no dependency). See supabase/schema.sql for the tables this
 * mirrors and docs/SUPABASE-SETUP.md for how to provision the project this talks to.
 *
 * Env: SUPABASE_URL, SUPABASE_SERVICE_KEY. Checked lazily, per call (not at module load), because
 * src/store.ts imports this module unconditionally even when the file backend is selected — an
 * eager top-level throw here would break the file-store path. Calling any exported function
 * without both vars set throws immediately and loudly; nothing here silently no-ops.
 *
 * Auth headers: every request sends BOTH `apikey` and `Authorization: Bearer <key>`. Verified this
 * session against Supabase's own docs: their current (2025+) key format wants the key on `apikey`
 * only, but explicitly says the platform "accepts them on either header" for migration
 * compatibility — and the classic JWT-based service_role key has always required
 * `Authorization: Bearer <jwt>` for PostgREST to resolve the `service_role` Postgres role (which is
 * what makes it bypass RLS). Sending both is the one form that is correct for either key format.
 *
 * Pagination: Supabase's REST API caps a single response at 1000 rows by default (verified via
 * Supabase's dashboard docs), and that cap is a project setting we can't see or rely on from here.
 * Every "load everything" function below pages through with limit/offset and only stops on a
 * genuinely EMPTY page — never on "fewer rows than I asked for" — so it is correct regardless of
 * whatever max-rows value the project actually has configured.
 */
import type { Paper, Author, User, AuthorWatch, LearnedProfile, WatcherConfig, SignupPrefs } from './types.ts';
import type { FeedbackRow } from './state.ts';

export type { FeedbackRow } from './state.ts';

// ----------------------------------------------------------------------------
// Low-level PostgREST plumbing
// ----------------------------------------------------------------------------

function env(): { url: string; key: string } {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) {
    throw new Error(
      '[store-supabase] SUPABASE_URL and SUPABASE_SERVICE_KEY must both be set to use the ' +
      'Supabase backend. Set both, or unset SUPABASE_URL entirely to fall back to the file store ' +
      '(see src/store.ts). Refusing to silently no-op.',
    );
  }
  return { url: url.replace(/\/+$/, ''), key };
}

interface RequestOpts {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  query?: Record<string, string>;
  body?: unknown;
  /** Values joined with ',' into a single Prefer header, e.g. ['resolution=merge-duplicates']. */
  prefer?: string[];
}

async function pgRequest(table: string, opts: RequestOpts = {}): Promise<Response> {
  const { url, key } = env();
  const qs = opts.query ? `?${new URLSearchParams(opts.query).toString()}` : '';
  const res = await fetch(`${url}/rest/v1/${table}${qs}`, {
    method: opts.method ?? 'GET',
    headers: {
      apikey: key,
      authorization: `Bearer ${key}`,
      'content-type': 'application/json',
      ...(opts.prefer ? { prefer: opts.prefer.join(',') } : {}),
    },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '<unreadable body>');
    throw new Error(`[store-supabase] ${opts.method ?? 'GET'} ${table} failed: ${res.status} ${res.statusText} — ${text}`);
  }
  return res;
}

/** One-shot GET with exact caller-controlled query params. No auto-pagination. */
async function restGet<T>(table: string, query: Record<string, string>): Promise<T[]> {
  const res = await pgRequest(table, { query });
  return (await res.json()) as T[];
}

const PAGE_SIZE = 1000;

/** Pages through every row matching `query`, stopping only on a genuinely empty page. */
async function fetchAll<T>(table: string, query: Record<string, string> = {}): Promise<T[]> {
  const out: T[] = [];
  let offset = 0;
  for (;;) {
    const page = await restGet<T>(table, { ...query, limit: String(PAGE_SIZE), offset: String(offset) });
    if (page.length === 0) break;
    out.push(...page);
    offset += page.length;
  }
  return out;
}

/** Exact row count via `Prefer: count=exact`, read back off the Content-Range response header. */
async function countRows(table: string, query: Record<string, string> = {}): Promise<number> {
  const { url, key } = env();
  const qs = new URLSearchParams({ ...query, limit: '1' }).toString();
  const res = await fetch(`${url}/rest/v1/${table}?${qs}`, {
    headers: { apikey: key, authorization: `Bearer ${key}`, prefer: 'count=exact' },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '<unreadable body>');
    throw new Error(`[store-supabase] count on ${table} failed: ${res.status} ${res.statusText} — ${text}`);
  }
  const range = res.headers.get('content-range'); // "<start>-<end>/<total>" e.g. "0-24/3573458"
  const total = range?.split('/')[1];
  if (!total || total === '*') {
    throw new Error(`[store-supabase] count on ${table}: unparseable Content-Range "${range}"`);
  }
  return Number(total);
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// ----------------------------------------------------------------------------
// papers (table: papers) — mirrors state.ts's loadPapers / upsertPapers / papersSince
// ----------------------------------------------------------------------------

const PAPER_COLUMNS = 'pmid,title,abstract,journal,pub_types,mesh,mesh_major,authors,edat,pubdate,doi,language';

interface PaperRow {
  pmid: string;
  title: string;
  abstract: string;
  journal: string;
  pub_types: string[];
  mesh: string[];
  mesh_major: string[];
  authors: Author[];
  edat: string;
  pubdate: string;
  doi: string | null;
  language: string[];
}

function rowToPaper(r: PaperRow): Paper {
  return {
    pmid: r.pmid, title: r.title, abstract: r.abstract, journal: r.journal,
    pubTypes: r.pub_types, mesh: r.mesh, meshMajor: r.mesh_major, authors: r.authors,
    edat: r.edat, pubdate: r.pubdate, doi: r.doi ?? undefined, language: r.language,
  };
}

function paperToRow(p: Paper): PaperRow {
  return {
    pmid: p.pmid, title: p.title, abstract: p.abstract, journal: p.journal,
    pub_types: p.pubTypes, mesh: p.mesh, mesh_major: p.meshMajor, authors: p.authors,
    edat: p.edat, pubdate: p.pubdate, doi: p.doi ?? null, language: p.language,
  };
}

export async function loadPapers(): Promise<Record<string, Paper>> {
  const rows = await fetchAll<PaperRow>('papers', { select: PAPER_COLUMNS });
  const out: Record<string, Paper> = {};
  for (const r of rows) out[r.pmid] = rowToPaper(r);
  return out;
}

export async function upsertPapers(ps: Paper[]): Promise<{ added: number; total: number }> {
  if (ps.length === 0) return { added: 0, total: await countRows('papers') };

  // Last-wins de-dup within the batch — mirrors state.ts's `db[p.pmid] = p` overwrite loop.
  const byPmid = new Map<string, Paper>();
  for (const p of ps) byPmid.set(p.pmid, p);
  const uniquePmids = [...byPmid.keys()];

  // "added" = pmids in this batch not already in the store, checked BEFORE the upsert. Chunked:
  // an `in.(...)` filter has no documented size ceiling, but a very long query string risks a
  // proxy/URL-length limit, so 300 ids per existence check keeps every request comfortably short.
  const existing = new Set<string>();
  for (const idsChunk of chunk(uniquePmids, 300)) {
    const rows = await restGet<{ pmid: string }>('papers', { select: 'pmid', pmid: `in.(${idsChunk.join(',')})` });
    for (const r of rows) existing.add(r.pmid);
  }
  const added = uniquePmids.filter((id) => !existing.has(id)).length;

  for (const batch of chunk([...byPmid.values()], 500)) {
    await pgRequest('papers', {
      method: 'POST',
      body: batch.map(paperToRow),
      prefer: ['resolution=merge-duplicates', 'return=minimal'], // pmid is the PK; no on_conflict needed
    });
  }

  return { added, total: await countRows('papers') };
}

export async function papersSince(days: number): Promise<Paper[]> {
  const cut = new Date(Date.now() - days * 864e5).toISOString().slice(0, 10);
  const rows = await fetchAll<PaperRow>('papers', { select: PAPER_COLUMNS, edat: `gte.${cut}` });
  return rows.map(rowToPaper);
}

// ----------------------------------------------------------------------------
// users (tables: users, user_templates, user_config, author_watches)
// ----------------------------------------------------------------------------
//
// User.templates / User.prefs.templates and User.prefs.authors are reconstructed from the
// relational tables (user_templates ordered by `position`, author_watches), never duplicated
// inside user_config.config — one place to drift, not two. user_config.config holds only
// `overrides` (User.overrides verbatim) and `prefs` (the slice of SignupPrefs with no dedicated
// table: journalTier, pubTypes, extraKeywords). `config->learned_profile` is loadProfile/
// saveProfile's own territory (see below) and is left untouched by loadUsers/saveUsers.
// A user with no user_config row at all gets `prefs: undefined` and `overrides: undefined`,
// matching the file store's seed user (data/users.json's "neel" row has neither key).

interface UserRow {
  id: string;
  email: string;
  verified_at: string | null;
  cadence: 'weekly' | 'monthly';
  llm_tier: boolean;
  unsub_token: string;
}
interface UserConfigJson {
  overrides?: Partial<WatcherConfig>;
  prefs?: { journalTier?: SignupPrefs['journalTier']; pubTypes?: string[]; extraKeywords?: string[] };
  learned_profile?: LearnedProfile;
}

export async function loadUsers(): Promise<User[]> {
  const [userRows, templateRows, configRows, authorRows] = await Promise.all([
    fetchAll<UserRow>('users', { select: 'id,email,verified_at,cadence,llm_tier,unsub_token' }),
    fetchAll<{ user_id: string; template_slug: string }>('user_templates', {
      select: 'user_id,template_slug', order: 'user_id.asc,position.asc',
    }),
    fetchAll<{ user_id: string; config: UserConfigJson }>('user_config', { select: 'user_id,config' }),
    fetchAll<{ user_id: string; orcid: string; label: string | null }>('author_watches', {
      select: 'user_id,orcid,label',
    }),
  ]);

  const templatesByUser = new Map<string, string[]>();
  for (const t of templateRows) {
    if (!templatesByUser.has(t.user_id)) templatesByUser.set(t.user_id, []);
    templatesByUser.get(t.user_id)!.push(t.template_slug);
  }

  const authorsByUser = new Map<string, AuthorWatch[]>();
  for (const a of authorRows) {
    if (!authorsByUser.has(a.user_id)) authorsByUser.set(a.user_id, []);
    authorsByUser.get(a.user_id)!.push({ orcid: a.orcid, ...(a.label ? { label: a.label } : {}) });
  }

  const configByUser = new Map(configRows.map((c) => [c.user_id, c.config ?? {}]));

  return userRows.map((r): User => {
    const templates = templatesByUser.get(r.id) ?? [];
    const authors = authorsByUser.get(r.id) ?? [];
    const cfg = configByUser.get(r.id);
    const user: User = {
      id: r.id,
      email: r.email,
      templates,
      cadence: r.cadence,
      llmTier: r.llm_tier,
      ...(r.verified_at ? { verifiedAt: r.verified_at } : {}),
      ...(r.unsub_token ? { unsubToken: r.unsub_token } : {}),
    };
    if (cfg) {
      if (cfg.overrides) user.overrides = cfg.overrides;
      user.prefs = {
        email: r.email,
        cadence: r.cadence,
        templates,
        journalTier: cfg.prefs?.journalTier ?? 'tier12',
        pubTypes: cfg.prefs?.pubTypes ?? [],
        extraKeywords: cfg.prefs?.extraKeywords ?? [],
        authors,
      };
    }
    return user;
  });
}

export async function saveUsers(users: User[]): Promise<void> {
  // Full-replace semantics, matching state.ts's `wr('users.json', u)`: the given array becomes
  // the entire store. A user present in the DB but absent from `users` is deleted, cascading (via
  // each table's ON DELETE CASCADE) to their user_templates/user_config/author_watches/user_seen/
  // feedback/digests rows — exactly as they would vanish from an overwritten users.json.
  const keepIds = new Set(users.map((u) => u.id));
  const currentIds = (await fetchAll<{ id: string }>('users', { select: 'id' })).map((r) => r.id);
  const toDelete = currentIds.filter((id) => !keepIds.has(id));
  for (const idsChunk of chunk(toDelete, 300)) {
    await pgRequest('users', { method: 'DELETE', query: { id: `in.(${idsChunk.join(',')})` } });
  }
  if (users.length === 0) return;

  const userRows: UserRow[] = users.map((u) => ({
    id: u.id,
    email: u.email,
    verified_at: u.verifiedAt ?? null,
    cadence: u.cadence,
    llm_tier: u.llmTier,
    unsub_token: u.unsubToken ?? crypto.randomUUID(),
  }));
  await pgRequest('users', { method: 'POST', body: userRows, prefer: ['resolution=merge-duplicates', 'return=minimal'] });

  // user_templates: delete-then-insert per user — simplest correct way to reflect a possibly
  // reordered or shortened templates[] array (position = array index).
  for (const u of users) {
    await pgRequest('user_templates', { method: 'DELETE', query: { user_id: `eq.${u.id}` } });
    if (u.templates.length > 0) {
      await pgRequest('user_templates', {
        method: 'POST',
        body: u.templates.map((slug, i) => ({ user_id: u.id, template_slug: slug, position: i })),
        prefer: ['return=minimal'],
      });
    }
  }

  // author_watches: same delete-then-insert approach, sourced from prefs.authors.
  for (const u of users) {
    await pgRequest('author_watches', { method: 'DELETE', query: { user_id: `eq.${u.id}` } });
    const authors = u.prefs?.authors ?? [];
    if (authors.length > 0) {
      await pgRequest('author_watches', {
        method: 'POST',
        body: authors.map((a) => ({ user_id: u.id, orcid: a.orcid, label: a.label ?? null })),
        prefer: ['return=minimal'],
      });
    }
  }

  // user_config: upsert a row for users that now have overrides/prefs, delete it for users that
  // no longer do — otherwise a stale config could survive a save that cleared it. This never
  // touches config->learned_profile for users it upserts, because loadProfile/saveProfile are the
  // only writers of that key; see the read-modify-write in saveProfile below.
  const withConfig = users.filter((u) => u.overrides || u.prefs);
  const withoutConfig = users.filter((u) => !u.overrides && !u.prefs);
  for (const idsChunk of chunk(withoutConfig.map((u) => u.id), 300)) {
    await pgRequest('user_config', { method: 'DELETE', query: { user_id: `in.(${idsChunk.join(',')})` } });
  }
  if (withConfig.length > 0) {
    // Preserve each user's existing learned_profile (if any) rather than clobbering it, since this
    // function has no LearnedProfile input to write.
    const existing = await restGet<{ user_id: string; config: UserConfigJson }>('user_config', {
      select: 'user_id,config', user_id: `in.(${withConfig.map((u) => u.id).join(',')})`,
    });
    const learnedByUser = new Map(existing.map((r) => [r.user_id, r.config?.learned_profile]));
    const configRows = withConfig.map((u) => ({
      user_id: u.id,
      config: {
        ...(u.overrides ? { overrides: u.overrides } : {}),
        ...(u.prefs
          ? { prefs: { journalTier: u.prefs.journalTier, pubTypes: u.prefs.pubTypes, extraKeywords: u.prefs.extraKeywords } }
          : {}),
        ...(learnedByUser.get(u.id) ? { learned_profile: learnedByUser.get(u.id) } : {}),
      },
    }));
    await pgRequest('user_config', { method: 'POST', body: configRows, prefer: ['resolution=merge-duplicates', 'return=minimal'] });
  }
}

// ----------------------------------------------------------------------------
// user_seen (table: user_seen) — the dedup ledger
// ----------------------------------------------------------------------------

const SEEN_LEDGER_CAP = 5000; // mirrors state.ts's `.slice(-5000)` per-user cap

export async function loadSeen(): Promise<Record<string, string[]>> {
  const rows = await fetchAll<{ user_id: string; pmid: string }>('user_seen', {
    select: 'user_id,pmid', order: 'user_id.asc,seen_at.asc',
  });
  const out: Record<string, string[]> = {};
  for (const r of rows) (out[r.user_id] ??= []).push(r.pmid);
  return out;
}

export async function markSeen(userId: string, pmids: string[]): Promise<void> {
  const unique = [...new Set(pmids)];
  if (unique.length === 0) return;
  for (const batch of chunk(unique, 500)) {
    await pgRequest('user_seen', {
      method: 'POST',
      body: batch.map((pmid) => ({ user_id: userId, pmid })),
      prefer: ['resolution=merge-duplicates', 'return=minimal'],
    });
  }
  // Trim to the newest SEEN_LEDGER_CAP rows for this user. If a project's dashboard max-rows
  // setting is below `excess`, this deletes fewer than intended in one call — harmless, since the
  // next markSeen() re-checks the total and trims further; it never leaves the ledger short.
  const total = await countRows('user_seen', { user_id: `eq.${userId}` });
  if (total <= SEEN_LEDGER_CAP) return;
  const excess = total - SEEN_LEDGER_CAP;
  const oldest = await restGet<{ pmid: string }>('user_seen', {
    select: 'pmid', user_id: `eq.${userId}`, order: 'seen_at.asc', limit: String(excess),
  });
  for (const batch of chunk(oldest.map((r) => r.pmid), 300)) {
    await pgRequest('user_seen', { method: 'DELETE', query: { user_id: `eq.${userId}`, pmid: `in.(${batch.join(',')})` } });
  }
}

export async function hasSeen(userId: string): Promise<Set<string>> {
  const rows = await fetchAll<{ pmid: string }>('user_seen', { select: 'pmid', user_id: `eq.${userId}` });
  return new Set(rows.map((r) => r.pmid));
}

// ----------------------------------------------------------------------------
// feedback (table: feedback)
// ----------------------------------------------------------------------------

export async function loadFeedback(): Promise<FeedbackRow[]> {
  const rows = await fetchAll<{ user_id: string; pmid: string; tag: FeedbackRow['tag']; created_at: string }>(
    'feedback', { select: 'user_id,pmid,tag,created_at', order: 'created_at.asc' },
  );
  return rows.map((r) => ({ userId: r.user_id, pmid: r.pmid, tag: r.tag, at: r.created_at }));
}

export async function addFeedback(r: Omit<FeedbackRow, 'at'>): Promise<void> {
  await pgRequest('feedback', {
    method: 'POST',
    body: { user_id: r.userId, pmid: r.pmid, tag: r.tag },
    prefer: ['return=minimal'],
  });
}

// ----------------------------------------------------------------------------
// learned profile (column: user_config.config->learned_profile)
// ----------------------------------------------------------------------------

export async function loadProfile(userId: string): Promise<LearnedProfile | null> {
  const rows = await restGet<{ config: UserConfigJson }>('user_config', {
    select: 'config', user_id: `eq.${userId}`, limit: '1',
  });
  return rows[0]?.config?.learned_profile ?? null;
}

export async function saveProfile(userId: string, lp: LearnedProfile): Promise<void> {
  // Read-modify-write so this never clobbers overrides/prefs stored alongside learned_profile in
  // the same JSONB column. Same non-atomicity the file store already has (rd -> mutate -> wr on
  // profiles.json), so this is parity, not a regression.
  const rows = await restGet<{ config: UserConfigJson }>('user_config', {
    select: 'config', user_id: `eq.${userId}`, limit: '1',
  });
  const merged: UserConfigJson = { ...(rows[0]?.config ?? {}), learned_profile: lp };
  await pgRequest('user_config', {
    method: 'POST',
    body: { user_id: userId, config: merged },
    prefer: ['resolution=merge-duplicates', 'return=minimal'],
  });
}
