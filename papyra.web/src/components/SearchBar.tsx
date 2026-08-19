import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Search, X } from 'lucide-react';
import { useNotes } from '../hooks/useNotes';
import { useSyncState } from '../hooks/useSync';
import { useAuth } from '../hooks/useAuth';
import { useCategories } from '../hooks/useCategories';
import { useCollections } from '../hooks/useCollections';
import { flattenMarkdown, normaliseLines } from '../lib/plainText';
import {
  GROUP_LABEL, categoryResults, collectionResults, noteResult, orderResults, settingsResults,
  type SearchResult,
} from '../lib/searchRegistry';
import type { Note } from '../types/note';
import './SearchBar.css';

interface Hit {
  id: string;
  title: string;
  snippet: string;
  secure?: boolean;
}

const DEBOUNCE_MS = 180;
const OFFLINE_SNIPPET = 120;

// Local fallback used when the Lucene endpoint can't be reached (offline, or the
// index is rebuilding). Substring matching over the cached vault — cruder than
// Lucene, but it means search never simply stops working.
function searchLocally(notes: Note[], query: string): Array<Hit & { rank: number }> {
  const q = query.toLowerCase();
  const ranked: Array<Hit & { rank: number }> = [];
  for (const n of notes) {
    if (n.trashed) continue;
    const inTitle = n.title.toLowerCase().includes(q);
    // Search the prose, not the markdown: matching the raw body could hit an
    // editor block anchor and show it back as the snippet.
    const body = n.secure ? '' : normaliseLines(flattenMarkdown(n.body));
    const at = n.secure ? -1 : body.toLowerCase().indexOf(q);
    if (!inTitle && at < 0) continue;
    const from = Math.max(0, at - 30);
    ranked.push({
      id: n.id,
      title: n.title || 'Untitled',
      secure: n.secure,
      snippet: at < 0 ? '' : `${from > 0 ? '…' : ''}${body.slice(from, from + OFFLINE_SNIPPET).trim()}…`,
      rank: inTitle ? 0 : 1, // title matches first, then body matches
    });
  }
  return ranked.sort((a, b) => a.rank - b.rank).slice(0, 12);
}

/**
 * Search over everything the app holds, not only notes.
 *
 * Notes and to-dos come from the Lucene endpoint (with a local substring
 * fallback); settings pages, categories and collections are matched client-side
 * against data already in the cache — see `lib/searchRegistry.ts`. Results are
 * grouped by what they are and labelled with a breadcrumb, so "Model" reads as
 * `Settings › AI` rather than as a mysterious bare word.
 *
 * Cmd/Ctrl+K focuses it from anywhere; ↑/↓ walk the results; Enter opens one.
 */
export default function SearchBar() {
  const navigate = useNavigate();
  const { data: notes } = useNotes();
  const { data: categories } = useCategories();
  const { data: collections } = useCollections();
  const { user } = useAuth();
  const { online } = useSyncState();
  const [query, setQuery] = useState('');
  const [noteHits, setNoteHits] = useState<Array<Hit & { rank: number }>>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [offlineResults, setOfflineResults] = useState(false);
  // Index returned nothing but the raw text matched — results are substring-only.
  const [partial, setPartial] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  const cached = useMemo(() => notes ?? [], [notes]);
  const isAdmin = user?.role === 'Admin';

  const close = useCallback(() => { setOpen(false); setActive(0); }, []);

  // Debounced query. The local fallback runs synchronously so results never
  // disappear while the network attempt is in flight.
  useEffect(() => {
    const q = query.trim();
    if (!q) { setNoteHits([]); setOfflineResults(false); return; }

    const local = searchLocally(cached, q);
    setNoteHits(local);
    setOfflineResults(true);
    setPartial(false);
    if (!online) return;

    let cancelled = false;
    const timer = setTimeout(() => {
      void fetch(`/api/search?q=${encodeURIComponent(q)}`)
        .then((res) => (res.ok ? res.json() : Promise.reject(new Error(String(res.status)))))
        .then((remote: Hit[]) => {
          // A slower answer for an older query must never overwrite a newer one.
          if (cancelled) return;
          // Lucene doesn't stem, so "note" misses a note titled "Field notes".
          // When the index has nothing but the raw text plainly does, keep the
          // substring matches rather than showing a bare "No matches".
          if (remote.length === 0 && local.length > 0) {
            // The server DID answer — label these as partial, not as offline.
            setOfflineResults(false);
            setPartial(true);
            return;
          }
          // The endpoint ranks by relevance, so position IS the rank.
          setNoteHits(remote.slice(0, 12).map((hit, i) => ({ ...hit, rank: i })));
          setOfflineResults(false);
          setPartial(false);
        })
        .catch(() => { /* keep the local results — they're already on screen */ });
    }, DEBOUNCE_MS);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [query, cached, online]);

  // Everything the client can answer for itself is matched here — no debounce,
  // no network, so settings and categories appear the instant a key lands.
  const results: SearchResult[] = useMemo(() => {
    const q = query.trim();
    if (!q) return [];
    const kinds = new Map(cached.map(n => [n.id, n.kind]));
    return orderResults([
      ...noteHits.map(hit => noteResult(hit, kinds.get(hit.id) ?? 'note', hit.rank)),
      ...settingsResults(q, isAdmin),
      ...categoryResults(categories ?? [], q),
      ...collectionResults(collections ?? [], q),
    ]);
  }, [query, noteHits, cached, isAdmin, categories, collections]);

  // The keyboard walks a flat list; the headings are drawn from it, not around
  // it. Clamp on read rather than in an effect — the list shrinks on every
  // keystroke, and a stale index for one paint would highlight the wrong row.
  const activeIndex = results.length === 0 ? 0 : Math.min(active, results.length - 1);

  // Cmd/Ctrl+K from anywhere. Deliberately not a bare "/" — that would hijack
  // the key while the user is typing a path or a fraction into a note.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
        setOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) close();
    };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [open, close]);

  function openHit(hit: SearchResult) {
    close();
    setQuery('');
    navigate(hit.to);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Escape') { close(); inputRef.current?.blur(); return; }
    if (!results.length) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((activeIndex + 1) % results.length); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((activeIndex - 1 + results.length) % results.length); }
    else if (e.key === 'Enter') { e.preventDefault(); openHit(results[activeIndex]); }
  }

  const showPanel = open && query.trim().length > 0;
  // Only note results come from the index, so the offline and partial notices
  // would be lying if a settings match were the only thing on screen.
  const hasNoteResults = results.some(r => r.source === 'note' || r.source === 'todo' || r.source === 'inbox');

  return (
    <div className={`search${showPanel ? ' search--open' : ''}`} ref={wrapRef}>
      <div className="search__field">
        <Search className="search__icon" size={16} aria-hidden="true" />
        <input
          ref={inputRef}
          className="search__input"
          type="search"
          value={query}
          placeholder="Search"
          aria-label="Search notes, to-dos and settings"
          role="combobox"
          aria-expanded={showPanel}
          aria-controls="search-results"
          aria-autocomplete="list"
          onChange={(e) => { setQuery(e.target.value); setOpen(true); setActive(0); }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
        />
        {query ? (
          <button
            type="button"
            className="search__clear"
            aria-label="Clear search"
            onClick={() => { setQuery(''); inputRef.current?.focus(); }}
          >
            <X size={14} />
          </button>
        ) : (
          <kbd className="search__kbd" aria-hidden="true">⌘K</kbd>
        )}
      </div>

      {/* Results ride above a blurred scrim, the same way an open note does, so
          searching reads as a modal surface rather than a dropdown hanging off
          the header. The scrim is a sibling (not a parent) of the list so the
          backdrop filter never applies to the results themselves. */}
      {showPanel && (
        <div
          className="search__scrim"
          aria-hidden="true"
          onMouseDown={() => { close(); }}
        />
      )}

      {showPanel && (
        <ul className="search__results" id="search-results" role="listbox">
          {results.length === 0 && <li className="search__empty">No matches.</li>}
          {results.map((hit, i) => (
            <li key={hit.key}>
              {/* A heading whenever the group changes. `aria-hidden` because the
                  breadcrumb inside each option already names its source — a
                  screen reader would otherwise hear the group twice. */}
              {(i === 0 || results[i - 1].source !== hit.source) && (
                <p className="search__group" aria-hidden="true">{GROUP_LABEL[hit.source]}</p>
              )}
              <button
                type="button"
                role="option"
                aria-selected={i === activeIndex}
                className={`search__hit${i === activeIndex ? ' search__hit--active' : ''}`}
                onMouseEnter={() => setActive(i)}
                onClick={() => openHit(hit)}
              >
                <span className="search__hit-crumb">{hit.breadcrumb.join(' › ')}</span>
                <span className="search__hit-title">{hit.title}</span>
                {hit.secure
                  ? <span className="search__hit-snippet search__hit-snippet--locked">Locked note</span>
                  : hit.snippet && <span className="search__hit-snippet">{hit.snippet.replace(/<\/?[^>]+>/g, '')}</span>}
              </button>
            </li>
          ))}
          {offlineResults && hasNoteResults && (
            <li className="search__note">Searching this device — full-text search resumes when the server is back.</li>
          )}
          {!offlineResults && partial && hasNoteResults && (
            <li className="search__note">Close matches — nothing contains that word exactly.</li>
          )}
        </ul>
      )}
    </div>
  );
}
