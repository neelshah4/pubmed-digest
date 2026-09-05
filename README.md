# pubmed-digest

One ranked, deduplicated literature digest built from many PubMed searches — instead of the
N separate raw-title emails MyNCBI sends you.

## Why this exists

NLM's own alerts are free and good at what they do: a saved search becomes an email, daily,
weekly, or monthly, up to 200 hits. Two things they don't do:

1. **Merge.** One saved search, one email. Track eight topics, get eight emails, all unranked.
2. **Curate.** You get a blank query box. No maintained journal whitelist, no suppression rules,
   no sense of which of the 1,597 papers published in your journals this week actually matter.

This does both, plus it learns: every paper carries one-click `★ / ~ / skip` links, and those
tags shift next week's ranking.

## How it works

```
                 ~10 API calls/run, independent of user count
                              │
   ┌──────────────────────────▼───────────────────────────┐
   │  ingest.yml   daily 03:23 UTC  (GitHub Actions)      │
   │  ESearch union across 69 journals → EFetch in 200s   │
   │  → parse XML → upsert into papers store              │
   └──────────────────────────┬───────────────────────────┘
                              │
   ┌──────────────────────────▼───────────────────────────┐
   │  digest.yml   weekly Mon 11:23 UTC                   │
   │  for each user:                                      │
   │    filter  → suppression + PT + tier-3 CC gate       │
   │    score   → 0.4·tier + 0.3·type + 0.2·pref + 0.1·N  │
   │              × 7 multiplicative topic boosts         │
   │    assemble→ top 25, ≤5/section, ≤3 practice-changing│
   │    render  → inline-CSS HTML email                   │
   │    send    → Resend                                  │
   └──────────────────────────────────────────────────────┘
```

**The key design decision is the union pull.** Naively you'd run each user's query against PubMed
— which dies around 30 users on E-utilities' 10 req/s. Instead one nightly pull fetches the union
of everyone's journals (measured: **1,597 records/week across all 69**, about 10 API calls), caches
them, and every user's filter runs locally against that cache. Ingest cost is O(1) in users.

### Scoring

Ported from a working single-user system, unchanged:

| Component | Weight |
|---|---|
| Journal tier (T1 1.0 / T2 0.8 / T3 0.5) | 0.40 |
| Study type (RCT & guideline 1.0 → editorial 0.30) | 0.30 |
| Preference match (sparse cosine vs your tags) | 0.20 |
| Sample size (log-scaled, floored for peds) | 0.10 |

then multiplied by: pediatric ×1.5, ECMO ×1.3, PARDS/mech-vent ×1.3, society guideline ×1.4,
informatics/AI ×1.25, hemodynamics ×1.20, EIT ×1.30, plus per-journal overrides.

Boosts stack, so a pediatric ECMO paper in a Tier-3 journal can beat a Tier-1 adult observational
study. That's intentional.

### Personalization without a model

`learned_profile` is a sparse vector of MeSH terms and abstract n-grams.

- `★` adds the paper's terms to the positive vector (+1)
- `skip` adds to the negative vector (+1)
- `~` adds to positive at +0.3
- everything decays 0.9× per month
- `preference_match = cos(paper, positive) − 0.5 · cos(paper, negative)`

No embeddings, no LLM, no per-user inference cost. Two invariants the original system learned the
hard way and this preserves: the curated `gold_seed_distribution` is a **protected floor**
re-unioned every run, and a run with no new tags must never blank the positive vector.

### Closing the prose gap

The source config is ~80% machine-executable (MeSH lists, n-gram lists, tiers, weights) and ~20%
prose an LLM was expected to interpret — "detected via pediatric population phrasing". Every one of
those became an explicit term list in `src/score/detect.ts`, and `Signals.matched` records exactly
which terms fired on each paper, so a disagreement with the original is adjudicated, not guessed at.

## Layout

```
src/
  types.ts            shared contracts — every module codes against these
  config.ts           template loading, journal→tier resolution
  state.ts            JSON store; maps 1:1 to the Supabase schema
  sources/eutils.ts   ESearch union + EFetch batching + backoff
  sources/parse.ts    PubMed XML → Paper (no dependencies)
  score/detect.ts     the 20% closure: explicit term lists + audit trail
  score/filter.ts     ordered filter pipeline
  score/profile.ts    sparse-vector preference match + feedback writeback
  score/score.ts      formula, section assignment, digest assembly
  render/email.ts     inline-CSS HTML + plain-text
web/index.html        static signup page (GitHub Pages)
```

## Run it

```bash
npm run ingest        # pull last 7 days into data/papers.json
npm run digest        # render to out/ — dry run by default
npm test
```

`DRY_RUN=false` sends for real and requires `RESEND_API_KEY` and `MAIL_FROM`.
`NCBI_API_KEY` is optional; it raises the rate limit from 3/s to 10/s.

## Status

Phase 1 — single-user, file-backed. Supabase (auth + Postgres) lands in phase 2 for
multi-tenancy. See the build plan for the full sequence.

---

Data courtesy of the U.S. National Library of Medicine. This tool is not affiliated with or
endorsed by NLM or NIH. Digests may not reflect NLM's most current data.
