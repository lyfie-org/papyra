/**
 * One registry for everything search can find.
 *
 * Search used to look at notes only, which meant a to-do and a settings page
 * were both unreachable from the one box people actually use. Every source now
 * produces the same `SearchResult` shape, carrying the source it came from, so
 * the UI can label a hit ("To Do", "Settings › AI") instead of showing a bare
 * title and hoping the user recognises it.
 *
 * Notes come from the server (Lucene, or the offline substring fallback);
 * everything else is matched here against data the client already holds.
 */

import type { Note } from '../types/note';
import type { Category } from '../hooks/useCategories';
import type { SmartCollection } from '../hooks/useCollections';
import { searchSettings, settingsHref } from './settingsIndex';

export type ResultSource = 'note' | 'todo' | 'inbox' | 'settings' | 'page' | 'category' | 'collection';

export interface SearchResult {
  /** Unique across sources — a note and a category may share a name. */
  key: string;
  source: ResultSource;
  title: string;
  /** Trail shown above the title: `['Settings', 'AI', 'On this machine']`. */
  breadcrumb: string[];
  /** Router path, ready for `navigate()`. */
  to: string;
  snippet?: string;
  secure?: boolean;
  /** Sorts within a group; groups themselves keep `GROUP_ORDER`. */
  rank: number;
}

/**
 * Groups appear in this order, always. Relevance decides the order *within* a
 * group, never between them — mixing a settings page in among notes by score
 * makes the list feel arbitrary, and the note is nearly always what was wanted.
 */
export const GROUP_ORDER: ResultSource[] = ['note', 'todo', 'inbox', 'settings', 'page', 'category', 'collection'];

export const GROUP_LABEL: Record<ResultSource, string> = {
  note: 'Notes',
  todo: 'To Do',
  inbox: 'Inbox',
  settings: 'Settings',
  page: 'Pages',
  category: 'Categories',
  collection: 'Collections',
};

/** The breadcrumb prefix for a note-shaped result, from its `kind`. */
function noteBreadcrumb(kind: Note['kind']): string[] {
  if (kind === 'todo') return ['To Do'];
  if (kind === 'inbox') return ['Inbox'];
  return ['Note'];
}

function sourceForKind(kind: Note['kind']): ResultSource {
  return kind === 'todo' ? 'todo' : kind === 'inbox' ? 'inbox' : 'note';
}

/** A note hit, whether it came from Lucene or the offline fallback. */
export function noteResult(
  hit: { id: string; title: string; snippet?: string; secure?: boolean },
  kind: Note['kind'],
  rank: number,
): SearchResult {
  return {
    key: `note:${hit.id}`,
    source: sourceForKind(kind),
    title: hit.title || 'Untitled',
    breadcrumb: noteBreadcrumb(kind),
    // The inbox note lives at its own page, not in the note editor.
    to: kind === 'inbox' ? '/inbox' : `/note/${encodeURIComponent(hit.id)}`,
    snippet: hit.snippet,
    secure: hit.secure,
    rank,
  };
}

export function settingsResults(query: string, isAdmin: boolean): SearchResult[] {
  return searchSettings(query, isAdmin).map(entry => ({
    key: `settings:${entry.tab}:${entry.section ?? ''}`,
    // An entry with its own href is a place in the app, not a settings panel —
    // it groups under "Pages" so the heading doesn't claim Manage Users lives
    // inside Settings, which is the exact confusion this split set out to fix.
    source: entry.href ? 'page' as const : 'settings' as const,
    title: entry.sectionLabel ?? entry.tabLabel,
    breadcrumb: entry.href ? ['Page'] : entry.section ? ['Settings', entry.tabLabel] : ['Settings'],
    to: settingsHref(entry),
    rank: entry.rank,
  }));
}

export function categoryResults(categories: Category[], query: string): SearchResult[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  return categories
    .filter(c => c.name.toLowerCase().includes(q))
    .map(c => ({
      key: `category:${c.name}`,
      source: 'category' as const,
      title: c.name,
      breadcrumb: ['Category'],
      to: `/categories?name=${encodeURIComponent(c.name)}`,
      snippet: `${c.count} ${c.count === 1 ? 'note' : 'notes'}`,
      rank: c.name.toLowerCase().startsWith(q) ? 0 : 1,
    }));
}

export function collectionResults(collections: SmartCollection[], query: string): SearchResult[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  return collections
    .filter(c => c.name.toLowerCase().includes(q))
    .map(c => ({
      key: `collection:${c.id}`,
      source: 'collection' as const,
      title: c.name,
      breadcrumb: ['Collection'],
      to: `/collections?id=${c.id}`,
      rank: c.name.toLowerCase().startsWith(q) ? 0 : 1,
    }));
}

/**
 * Flattens every source into one list in `GROUP_ORDER`, ranked within each
 * group. Flat, because the keyboard walks results with ↑/↓ and must not care
 * that they are drawn under headings.
 */
export function orderResults(results: SearchResult[], limitPerGroup = 6): SearchResult[] {
  const out: SearchResult[] = [];
  for (const source of GROUP_ORDER) {
    const group = results
      .filter(r => r.source === source)
      .sort((a, b) => a.rank - b.rank)
      .slice(0, limitPerGroup);
    out.push(...group);
  }
  return out;
}
