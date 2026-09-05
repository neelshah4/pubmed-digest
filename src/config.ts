import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { WatcherConfig } from './types.ts';

const here = dirname(fileURLToPath(import.meta.url));

export function listTemplates(): string[] {
  return readdirSync(here).filter((f) => f.endsWith('.template.json'))
    .map((f) => f.replace('.template.json', '')).sort();
}

export function loadTemplate(slug = 'peds-cc'): WatcherConfig {
  const path = join(here, `${slug}.template.json`);
  if (!existsSync(path)) {
    throw new Error(
      `Unknown template "${slug}". Available: ${listTemplates().join(', ')}. ` +
      `The signup page must not offer a template that has no backing file.`);
  }
  return JSON.parse(readFileSync(path, 'utf8')) as WatcherConfig;
}

/** Shallow-merge user overrides over a template. Arrays replace; objects merge one level. */
export function withOverrides(base: WatcherConfig, ov?: Partial<WatcherConfig>): WatcherConfig {
  if (!ov) return base;
  const out: any = { ...base };
  for (const [k, v] of Object.entries(ov)) {
    out[k] = Array.isArray(v) || typeof v !== 'object' || v === null
      ? v : { ...(base as any)[k], ...(v as any) };
  }
  return out as WatcherConfig;
}

export function allJournals(c: WatcherConfig): string[] {
  const j = c.journals;
  return [...j.tier_1_primary_cc, ...j.tier_2_top_general_plus_adjacent, ...j.tier_3_cc_relevance_gate];
}

export function journalTier(c: WatcherConfig, journal: string): 1 | 2 | 3 | null {
  const eq = (a: string, b: string) => a.toLowerCase().replace(/\.$/, '') === b.toLowerCase().replace(/\.$/, '');
  if (c.journals.tier_1_primary_cc.some((x) => eq(x, journal))) return 1;
  if (c.journals.tier_2_top_general_plus_adjacent.some((x) => eq(x, journal))) return 2;
  if (c.journals.tier_3_cc_relevance_gate.some((x) => eq(x, journal))) return 3;
  return null;
}
