/**
 * Phase-1 state: JSON files under data/. Deliberately a drop-in for Supabase —
 * every function here maps 1:1 to a table in the schema, so swapping the body
 * for a PostgREST call is a local change.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Paper, User, LearnedProfile } from './types.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = join(root, 'data');

function rd<T>(f: string, fallback: T): T {
  const p = join(DATA, f);
  if (!existsSync(p)) return fallback;
  try { return JSON.parse(readFileSync(p, 'utf8')) as T; } catch { return fallback; }
}
function wr(f: string, v: unknown): void {
  mkdirSync(DATA, { recursive: true });
  writeFileSync(join(DATA, f), JSON.stringify(v, null, 2));
}

// --- papers (table: papers) ------------------------------------------------
export const loadPapers = (): Record<string, Paper> => rd('papers.json', {});
export function upsertPapers(ps: Paper[]): { added: number; total: number } {
  const db = loadPapers();
  let added = 0;
  for (const p of ps) { if (!db[p.pmid]) added++; db[p.pmid] = p; }
  wr('papers.json', db);
  return { added, total: Object.keys(db).length };
}
/** Papers whose Entrez date falls in the last N days. */
export function papersSince(days: number): Paper[] {
  const cut = new Date(Date.now() - days * 864e5).toISOString().slice(0, 10);
  return Object.values(loadPapers()).filter((p) => p.edat >= cut);
}

// --- users (table: users, user_templates) ----------------------------------
export const loadUsers = (): User[] => rd('users.json', []);
export const saveUsers = (u: User[]): void => wr('users.json', u);

// --- user_seen (table: user_seen) — the dedup ledger ------------------------
export const loadSeen = (): Record<string, string[]> => rd('seen.json', {});
export function markSeen(userId: string, pmids: string[]): void {
  const s = loadSeen();
  s[userId] = [...new Set([...(s[userId] ?? []), ...pmids])].slice(-5000);
  wr('seen.json', s);
}
export const hasSeen = (userId: string): Set<string> => new Set(loadSeen()[userId] ?? []);

// --- feedback (table: feedback) --------------------------------------------
export interface FeedbackRow { userId: string; pmid: string; tag: 'star' | 'skip' | 'tilde'; at: string }
export const loadFeedback = (): FeedbackRow[] => rd('feedback.json', []);
export function addFeedback(r: Omit<FeedbackRow, 'at'>): void {
  const f = loadFeedback();
  f.push({ ...r, at: new Date().toISOString() });
  wr('feedback.json', f);
}

// --- learned profile (column: user_config.config->learned_profile) ----------
export const loadProfile = (userId: string): LearnedProfile | null =>
  rd<Record<string, LearnedProfile>>('profiles.json', {})[userId] ?? null;
export function saveProfile(userId: string, lp: LearnedProfile): void {
  const all = rd<Record<string, LearnedProfile>>('profiles.json', {});
  all[userId] = lp;
  wr('profiles.json', all);
}
