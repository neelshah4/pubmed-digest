/**
 * Backend selector: Supabase when SUPABASE_URL is set, otherwise the local file store
 * (src/state.ts). Every caller (cli-ingest.ts, cli-digest.ts, future endpoints, tests) imports
 * from HERE, never from state.ts or store-supabase.ts directly, so the backend is swapped in
 * exactly one place.
 *
 * Both modules are imported unconditionally (static ESM import), which is why
 * store-supabase.ts's env check lives inside each function rather than at module load — importing
 * it must never throw just because SUPABASE_URL happens to be unset.
 *
 * The exported interface is always Promise-returning, even for the file backend, whose underlying
 * functions are synchronous. That keeps callers writing `await store.fn(...)` uniformly regardless
 * of which backend is active — necessary once ANY backend is network-bound, and harmless for the
 * file backend since `await` on a non-Promise value just resolves immediately.
 */
import * as fileStore from './state.ts';
import * as supabaseStore from './store-supabase.ts';

export type { FeedbackRow } from './state.ts';

const backend = process.env.SUPABASE_URL ? supabaseStore : fileStore;

function wrap<Args extends unknown[], R>(fn: (...a: Args) => R | Promise<R>): (...a: Args) => Promise<R> {
  return (...a: Args) => Promise.resolve(fn(...a));
}

export const loadPapers = wrap(backend.loadPapers);
export const upsertPapers = wrap(backend.upsertPapers);
export const papersSince = wrap(backend.papersSince);
export const loadUsers = wrap(backend.loadUsers);
export const saveUsers = wrap(backend.saveUsers);
export const loadSeen = wrap(backend.loadSeen);
export const markSeen = wrap(backend.markSeen);
export const hasSeen = wrap(backend.hasSeen);
export const loadFeedback = wrap(backend.loadFeedback);
export const addFeedback = wrap(backend.addFeedback);
export const loadProfile = wrap(backend.loadProfile);
export const saveProfile = wrap(backend.saveProfile);
