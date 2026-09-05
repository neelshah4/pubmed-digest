/**
 * Public URLs used in emails. One place, so the digest, the unsubscribe header
 * and the confirmation mail can never drift apart.
 *
 * PUBLIC_BASE defaults to the GitHub Pages URL for this repo. Override it when
 * serving the static pages from a custom domain.
 */
import type { User } from './types.ts';

export const PUBLIC_BASE = (process.env.PUBLIC_BASE ?? 'https://neelshah4.github.io/pubmed-digest')
  .replace(/\/+$/, '');

export type FeedbackTag = 'star' | 'tilde' | 'skip';

export const feedbackBaseUrl = (): string => `${PUBLIC_BASE}/action.html?a=feedback`;

export function feedbackUrl(userId: string, pmid: string, tag: FeedbackTag): string {
  const q = new URLSearchParams({ a: 'feedback', pmid, tag, u: userId });
  return `${PUBLIC_BASE}/action.html?${q}`;
}

/** Token is required: without it anyone could unsubscribe anyone by guessing an id. */
export function unsubscribeUrl(u: Pick<User, 'id' | 'unsubToken'>): string {
  const q = new URLSearchParams({ a: 'unsubscribe', u: u.id, t: u.unsubToken ?? '' });
  return `${PUBLIC_BASE}/action.html?${q}`;
}

export function confirmUrl(u: Pick<User, 'id' | 'unsubToken'>): string {
  const q = new URLSearchParams({ a: 'confirm', u: u.id, t: u.unsubToken ?? '' });
  return `${PUBLIC_BASE}/action.html?${q}`;
}

/** mailto: fallback for the List-Unsubscribe header, alongside the https form. */
export const unsubscribeMailto = (u: Pick<User, 'id'>): string =>
  `mailto:${process.env.UNSUB_MAILBOX ?? 'unsubscribe@example.com'}?subject=unsubscribe+${encodeURIComponent(u.id)}`;
