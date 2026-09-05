-- pubmed-digest Supabase schema.
-- Run this once, top to bottom, in the Supabase SQL editor (Dashboard -> SQL Editor -> New query).
-- Idempotent: tables/indexes/the extension use IF NOT EXISTS, the seed row uses ON CONFLICT, and
-- every policy is preceded by a DROP POLICY IF EXISTS (Postgres's CREATE POLICY has no IF NOT
-- EXISTS form) -- so re-running the whole file is safe. Verified this session by running it twice
-- in a row against a real Postgres 16 instance; the second run also exits clean.
--
-- Table <-> src/state.ts export mapping (see that file's section comments):
--   users, user_templates   <- loadUsers / saveUsers
--   user_config             <- loadProfile / saveProfile (config->'learned_profile'), plus overrides + the
--                              non-relational half of SignupPrefs (config->'overrides', config->'prefs')
--   author_watches          <- the relational form of User.prefs.authors (AuthorWatch[])
--   papers                  <- loadPapers / upsertPapers / papersSince
--   user_seen               <- loadSeen / markSeen / hasSeen  (the dedup ledger)
--   feedback                <- loadFeedback / addFeedback
--   templates               <- catalog of valid template slugs (the JSON template *content* stays in
--                              src/*.template.json per src/config.ts; this table exists for FK integrity
--                              and so a future signup UI can list options from the DB)
--   digests                 <- sent-digest history (no src/state.ts export touches this yet; included
--                              because the build plan names it, kept minimal, RLS'd the same way)
--
-- ============================================================================
-- ROW LEVEL SECURITY: how this file uses it (verified this session, not assumed)
-- ============================================================================
-- auth.uid() is a Supabase helper that returns the caller's user id (the JWT's `sub` claim) or
-- NULL when the request carries no user JWT. Every policy below therefore guards with
-- `auth.uid() IS NOT NULL AND auth.uid() = user_id` rather than bare `auth.uid() = user_id`:
-- with a bare comparison, `NULL = user_id` evaluates to NULL (not TRUE) in SQL, so an
-- unauthenticated caller is already denied -- but Supabase's own RLS guide calls this out as a
-- silent-failure trap worth guarding explicitly, so this file does.
--
-- The service_role key (SUPABASE_SERVICE_KEY, used by src/store-supabase.ts and by GitHub Actions)
-- BYPASSES every policy in this file. This is not a policy this file writes -- it is a Postgres
-- role attribute: the service_role Postgres role Supabase provisions has `BYPASSRLS`, and RLS is
-- never evaluated at all for a role with that attribute, on any table, regardless of policies
-- defined. That is what makes it safe for the ingest/digest CLIs (which never see a user JWT) to
-- read and write every row. No table below needs an explicit "service_role can do anything"
-- policy -- writing one would be inert, since BYPASSRLS means policies are skipped for that role
-- entirely, not "matched by a permissive policy."
--
-- No user-facing client currently authenticates with Supabase Auth (this app's identity model is
-- double opt-in email + a bearer unsub_token, not Supabase sessions) -- so today, every
-- `auth.uid() = user_id` policy below is inert (auth.uid() is always NULL for this app's traffic)
-- and all real access goes through the service-role backend. These policies exist per the build
-- contract so that IF a signed-in client (e.g. a future "manage my subscription" page using
-- Supabase Auth) is added later, it is safe by default rather than by omission.
-- ============================================================================

-- citext: case-insensitive text, used for `users.email` so 'Neel@x.com' and 'neel@x.com' collide
-- as the same subscriber. One of Supabase's ~50 bundled extensions; Supabase's own docs say most
-- extensions install into the `extensions` schema, which is on the default search_path -- installing
-- into a schema named after the extension itself (a mistake seen in the wild) is what causes the
-- "permission denied for schema citext" error, not this form.
create extension if not exists citext with schema extensions;

-- gen_random_uuid(): NOT an extension dependency here. It moved into Postgres core in version 13
-- (pgcrypto's own implementation became a thin wrapper around the core one from that release on).
-- Supabase's managed Postgres is newer than 13 on every current plan, so no `create extension
-- pgcrypto` is needed for the uuid defaults below.

-- ----------------------------------------------------------------------------
-- users
-- ----------------------------------------------------------------------------
create table if not exists users (
  id          uuid primary key default gen_random_uuid(),
  email       citext not null unique,
  verified_at timestamptz,                 -- unset = never send (double opt-in), per types.ts User.verifiedAt
  cadence     text not null default 'weekly' check (cadence in ('weekly', 'monthly')),
  llm_tier    boolean not null default false,
  unsub_token uuid not null default gen_random_uuid() unique,
  created_at  timestamptz not null default now()
);

alter table users enable row level security;

drop policy if exists "users read own row" on users;
create policy "users read own row"
  on users for select
  using (auth.uid() is not null and auth.uid() = id);
-- Prevents: a signed-in caller reading any other subscriber's email, verification state, cadence,
-- or unsub_token by id or by scanning the table. This is the policy that matters most in this
-- file -- getting it wrong is the "leaks every subscriber's email to every other subscriber" case
-- the build contract calls out.

drop policy if exists "users update own row" on users;
create policy "users update own row"
  on users for update
  using (auth.uid() is not null and auth.uid() = id)
  with check (auth.uid() is not null and auth.uid() = id);
-- Prevents: a signed-in caller modifying another subscriber's row, and (via with check) prevents
-- re-pointing their own row's id at someone else's uuid mid-update.
-- No insert/delete policy: sign-up must mint unsub_token + verified_at atomically per business
-- rules the DB can't enforce (double opt-in email step), and unsubscribe is a soft state change,
-- not a row delete -- both stay service-role-only (the backend), matching "let the service-role
-- key do everything" from the build contract.

-- ----------------------------------------------------------------------------
-- templates -- catalog only; the JSON template bodies remain the source of truth (src/config.ts)
-- ----------------------------------------------------------------------------
create table if not exists templates (
  slug        text primary key,
  label       text not null,
  description text,
  created_at  timestamptz not null default now()
);

alter table templates enable row level security;

drop policy if exists "templates public read" on templates;
create policy "templates public read"
  on templates for select
  using (true);
-- Prevents: nothing sensitive -- this table holds no PII, only a catalog of template slugs/labels.
-- RLS is enabled anyway so this table doesn't trip Supabase's "RLS disabled on a public table"
-- advisory, and so a future signup UI can list templates with the anon key. No write policy: only
-- the service-role key (this file's seed insert, or a future admin task) may add a template.

insert into templates (slug, label, description) values
  ('peds-cc',  'Pediatric Critical Care',
   'Configuration for the pubmed-watcher agent. Edit this file freely -- the agent re-reads it on every run. Journal abbreviations follow PubMed''s [ta] field. Add/remove journals here without touching the agent prompt.'),
  ('adult-cc', 'Adult Critical Care',
   'Adult critical care. SEEDED from peds-cc: journal tiers, suppression rules and section queries are inherited unchanged. The pediatric multiplier is neutralised and the learned profile is emptied, because a preference profile trained on one reader''s pediatric reading is not transferable. NEEDS CURATION before real use.'),
  ('neurocrit', 'Neurocritical Care',
   'Neurocritical care. SEEDED from peds-cc via adult-cc. Neuro sections are boosted and non-neuro sections retained at base weight so cross-cutting papers still surface. NEEDS CURATION before real use.')
on conflict (slug) do nothing;

-- ----------------------------------------------------------------------------
-- user_templates -- backs the ordered User.templates: string[] (templates[0] is the "primary"
-- template cli-digest.ts loads); `position` preserves that order.
-- ----------------------------------------------------------------------------
create table if not exists user_templates (
  user_id       uuid not null references users(id) on delete cascade,
  template_slug text not null references templates(slug) on delete restrict,
  position      smallint not null default 0,
  primary key (user_id, template_slug)
);

create index if not exists user_templates_user_id_position_idx
  on user_templates (user_id, position);

alter table user_templates enable row level security;

drop policy if exists "user_templates own rows" on user_templates;
create policy "user_templates own rows"
  on user_templates for all
  using (auth.uid() is not null and auth.uid() = user_id)
  with check (auth.uid() is not null and auth.uid() = user_id);
-- Prevents: a signed-in caller reading, adding, or removing which templates ANOTHER subscriber is
-- enrolled in.

-- ----------------------------------------------------------------------------
-- user_config -- one JSONB blob per user. config->'learned_profile' is exactly the
-- LearnedProfile object loadProfile()/saveProfile() read and write (see src/state.ts's own
-- comment naming this path). config->'overrides' mirrors User.overrides (Partial<WatcherConfig>).
-- config->'prefs' holds the parts of SignupPrefs that have no dedicated relational table
-- (journalTier, pubTypes, extraKeywords) -- templates and authors are reconstructed from
-- user_templates / author_watches instead of being duplicated here, so there is one place that
-- can drift, not two.
-- ----------------------------------------------------------------------------
create table if not exists user_config (
  user_id    uuid primary key references users(id) on delete cascade,
  config     jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table user_config enable row level security;

drop policy if exists "user_config own row" on user_config;
create policy "user_config own row"
  on user_config for all
  using (auth.uid() is not null and auth.uid() = user_id)
  with check (auth.uid() is not null and auth.uid() = user_id);
-- Prevents: a signed-in caller reading or overwriting another subscriber's config overrides,
-- journal-tier / keyword preferences, or learned preference profile.

-- ----------------------------------------------------------------------------
-- author_watches -- the relational form of AuthorWatch[] (SignupPrefs.authors / User.prefs.authors).
-- ORCID format check mirrors src/sources/eutils.ts's own ORCID_RE
-- (/^\d{4}-\d{4}-\d{4}-\d{3}[0-9X]$/) so a malformed id can't reach the row-level store at all.
-- ----------------------------------------------------------------------------
create table if not exists author_watches (
  user_id    uuid not null references users(id) on delete cascade,
  orcid      text not null check (orcid ~ '^\d{4}-\d{4}-\d{4}-\d{3}[0-9X]$'),
  label      text,
  created_at timestamptz not null default now(),
  primary key (user_id, orcid)
);

create index if not exists author_watches_orcid_idx on author_watches (orcid);

alter table author_watches enable row level security;

drop policy if exists "author_watches own rows" on author_watches;
create policy "author_watches own rows"
  on author_watches for all
  using (auth.uid() is not null and auth.uid() = user_id)
  with check (auth.uid() is not null and auth.uid() = user_id);
-- Prevents: a signed-in caller seeing or editing which ORCIDs another subscriber follows.

-- ----------------------------------------------------------------------------
-- papers -- the union-pull cache. fts is a generated, indexed full-text column over title+abstract.
-- ----------------------------------------------------------------------------
create table if not exists papers (
  pmid       text primary key,
  title      text not null,
  abstract   text not null default '',
  journal    text not null,
  pub_types  text[] not null default '{}',
  mesh       text[] not null default '{}',
  mesh_major text[] not null default '{}',
  authors    jsonb not null default '[]'::jsonb,
  edat       date not null,   -- Entrez date; papersSince() filters on this
  pubdate    date not null,   -- may be normalised to the 1st of the month upstream; always a full date
  doi        text,
  language   text[] not null default '{}',
  -- Generated STORED column: computed on write, occupies storage, queryable like a normal column.
  -- `GENERATED ALWAYS AS (...) STORED` has been supported since Postgres 12 -- verified against the
  -- current PostgreSQL docs this session -- so this works on every Postgres version Supabase runs.
  fts        tsvector generated always as (
               to_tsvector('english', coalesce(title, '') || ' ' || coalesce(abstract, ''))
             ) stored,
  created_at timestamptz not null default now()
);

-- GIN index over the generated tsvector: what makes `papers?fts=fts.<query>` (or a raw
-- `to_tsquery` match in SQL) fast instead of a sequential scan.
create index if not exists papers_fts_idx on papers using gin (fts);

-- Supports papersSince()'s `edat >= cutoff` filter without scanning the whole table.
create index if not exists papers_edat_idx on papers (edat);

alter table papers enable row level security;

drop policy if exists "papers public read" on papers;
create policy "papers public read"
  on papers for select
  using (true);
-- Prevents: nothing sensitive -- papers are public PubMed metadata (title/abstract/journal/MeSH),
-- never subscriber data. RLS is enabled for lint compliance and so a future read-only client could
-- use the anon key safely. No write policy: only the service-role ingest job may write papers.

-- ----------------------------------------------------------------------------
-- user_seen -- the dedup ledger. Composite PK IS the dedup: a (user_id, pmid) pair can exist once.
-- ----------------------------------------------------------------------------
create table if not exists user_seen (
  user_id uuid not null references users(id) on delete cascade,
  pmid    text not null references papers(pmid) on delete cascade,
  seen_at timestamptz not null default now(),
  primary key (user_id, pmid)
);

alter table user_seen enable row level security;

drop policy if exists "user_seen read own" on user_seen;
create policy "user_seen read own"
  on user_seen for select
  using (auth.uid() is not null and auth.uid() = user_id);

drop policy if exists "user_seen insert own" on user_seen;
create policy "user_seen insert own"
  on user_seen for insert
  with check (auth.uid() is not null and auth.uid() = user_id);
-- Prevents (both policies): a signed-in caller reading another subscriber's seen-paper history
-- (which would otherwise leak what that subscriber has been shown), or inserting a row attributed
-- to someone else's user_id. No update/delete policy: markSeen() only ever adds pmids in the file
-- store, never rewrites or removes one, so this table is append-only by design here too.

-- ----------------------------------------------------------------------------
-- feedback -- the star/skip/tilde tagging log that drives the learned preference profile.
-- ----------------------------------------------------------------------------
create table if not exists feedback (
  id         bigint generated always as identity primary key,
  user_id    uuid not null references users(id) on delete cascade,
  pmid       text not null references papers(pmid) on delete cascade,
  tag        text not null check (tag in ('star', 'skip', 'tilde')),
  created_at timestamptz not null default now()
);

create index if not exists feedback_user_id_idx on feedback (user_id);
create index if not exists feedback_pmid_idx on feedback (pmid);

alter table feedback enable row level security;

drop policy if exists "feedback read own" on feedback;
create policy "feedback read own"
  on feedback for select
  using (auth.uid() is not null and auth.uid() = user_id);

drop policy if exists "feedback insert own" on feedback;
create policy "feedback insert own"
  on feedback for insert
  with check (auth.uid() is not null and auth.uid() = user_id);
-- Prevents (both policies): a signed-in caller reading another subscriber's tagging history, or
-- inserting feedback rows attributed to someone else's account. No update/delete policy:
-- addFeedback() only ever appends in the file store, so this stays an immutable event log here.

-- ----------------------------------------------------------------------------
-- digests -- sent-digest history. Not yet written by any src/state.ts export (no loadDigests /
-- saveDigest function exists to mirror), included because the build plan names this table; kept
-- minimal and RLS'd the same way as every other user-data table so it is safe the day something
-- starts writing to it.
-- ----------------------------------------------------------------------------
create table if not exists digests (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid not null references users(id) on delete cascade,
  generated_at        timestamptz not null default now(),
  window_days         integer not null,
  subject             text,
  total_candidates    integer,
  total_after_filter  integer,
  sent_at             timestamptz,
  created_at          timestamptz not null default now()
);

create index if not exists digests_user_id_idx on digests (user_id);

alter table digests enable row level security;

drop policy if exists "digests read own" on digests;
create policy "digests read own"
  on digests for select
  using (auth.uid() is not null and auth.uid() = user_id);
-- Prevents: a signed-in caller reading another subscriber's sent-digest history. No write policy:
-- digests are only ever written by the service-role digest job.

alter table users add column if not exists unsubscribed_at timestamptz;
-- Lets record_feedback() upsert instead of stacking duplicate rows per paper.
create unique index if not exists feedback_user_pmid_uidx on feedback (user_id, pmid);

-- ----------------------------------------------------------------------------
-- Token-authenticated actions from digest emails.
--
-- Someone clicking a link in an email is NOT authenticated, so auth.uid() is
-- null and every RLS policy above correctly refuses them. Without these
-- functions the star/maybe/skip links, the unsubscribe link and the confirmation
-- link would all silently fail — the RLS policies and the emailed links were
-- written against different assumptions.
--
-- Each function is SECURITY DEFINER (so it runs with the owner's rights and
-- bypasses RLS) but authorises on an unguessable per-user token instead. Every
-- one pins `search_path`: a SECURITY DEFINER function without a pinned
-- search_path can be hijacked by a caller-controlled schema, which is the
-- classic Postgres privilege-escalation route.
-- ----------------------------------------------------------------------------

create or replace function record_feedback(
  p_user uuid, p_token uuid, p_pmid text, p_tag text
) returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_ok boolean;
begin
  if p_tag not in ('star', 'tilde', 'skip') then
    raise exception 'invalid tag';
  end if;

  select exists (select 1 from users u where u.id = p_user and u.unsub_token = p_token)
    into v_ok;
  if not v_ok then
    return false;   -- wrong or missing token: report failure, never say why
  end if;

  insert into feedback (user_id, pmid, tag)
  values (p_user, p_pmid, p_tag)
  on conflict (user_id, pmid) do update set tag = excluded.tag, created_at = now();

  return true;
end;
$$;

create or replace function unsubscribe(p_user uuid, p_token uuid)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_ok boolean;
begin
  update users
     set verified_at = null, unsubscribed_at = now()
   where id = p_user and unsub_token = p_token
  returning true into v_ok;
  return coalesce(v_ok, false);
end;
$$;

create or replace function confirm_subscription(p_user uuid, p_token uuid)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_ok boolean;
begin
  -- Double opt-in: until verified_at is set, sendDigest refuses to send at all.
  update users
     set verified_at = coalesce(verified_at, now()), unsubscribed_at = null
   where id = p_user and unsub_token = p_token
  returning true into v_ok;
  return coalesce(v_ok, false);
end;
$$;

-- The anon key may call these three and nothing else. Writes still go through
-- the token check inside each function.
revoke all on function record_feedback(uuid, uuid, text, text) from public;
revoke all on function unsubscribe(uuid, uuid) from public;
revoke all on function confirm_subscription(uuid, uuid) from public;
grant execute on function record_feedback(uuid, uuid, text, text) to anon, authenticated;
grant execute on function unsubscribe(uuid, uuid) to anon, authenticated;
grant execute on function confirm_subscription(uuid, uuid) to anon, authenticated;

-- ----------------------------------------------------------------------------
-- Table-level GRANTs — required independent of every RLS policy above, and independent of the
-- RPC functions above.
--
-- Verified this session via Supabase's own changelog: starting 2026-05-30, a new project can opt
-- out of automatically granting anon/authenticated/service_role privileges on newly created
-- tables (the "Automatically expose new tables" checkbox at project creation); starting
-- 2026-10-30, EVERY project — new and already-existing — stops auto-granting on newly CREATED
-- tables regardless of that checkbox (tables that already existed before the cutover keep the
-- grants they already have). Since this file creates brand-new tables and may be run on a project
-- made at any point relative to those two dates, none of the RLS policies above are reachable
-- without the GRANTs below: RLS decides which ROWS a request can touch, but a role needs the
-- underlying table privilege before RLS is even evaluated. Left out, `service_role` itself could
-- be refused with a bare 42501 on a project where auto-grant is off — which reads as "the schema
-- is broken" when the real cause is a missing privilege. These statements follow the manual fix
-- Supabase's own changelog gives for this change.
-- ----------------------------------------------------------------------------

-- service_role: BYPASSRLS skips row-filtering, it does not imply a table GRANT — the two are
-- independent privilege checks. This is the role src/store-supabase.ts runs as; without this,
-- the ingest/digest GitHub Actions jobs would fail outright on an affected project.
grant select, insert, update, delete on
  users, templates, user_templates, user_config, author_watches, papers, user_seen, feedback, digests
  to service_role;

-- anon / authenticated: scoped to exactly what each table's RLS policies above already allow a
-- signed-in (or, for the two public tables, unauthenticated) caller to do. Granting more than the
-- RLS policies permit would be inert — RLS still filters rows either way — but is avoided anyway
-- on least-privilege grounds. Note this section is unrelated to the emailed action links: those
-- SECURITY DEFINER functions run with their OWNER's privileges, not the caller's, so `anon` needs
-- no table grant on users/feedback to use them — only the `grant execute` above matters there.
grant select on papers, templates to anon, authenticated;
grant select, update on users to authenticated;
grant select, insert, update, delete on user_templates, user_config, author_watches to authenticated;
grant select, insert on user_seen, feedback to authenticated;
grant select on digests to authenticated;
