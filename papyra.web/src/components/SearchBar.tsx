import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Search, X } from 'lucide-react';
import { useNotes } from '../hooks/useNotes';
import { useSyncState } from '../hooks/useSync';
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
function searchLocally(notes: Note[], query: string): Hit[] {
  const q = query.toLowerCase();
  const ranked: Array<Hit & { rank: number }> = [];
  for (const n of notes) {
    if (n.trashed) continue;
    const inTitle = n.title.toLowerCase().includes(q);
    // A secure note's body is withheld by the API, so only its title is matchable.
    const at = n.secure ? -1 : n.body.toLowerCase().indexOf(q);
    if (!inTitle && at < 0) continue;
    const from = Math.max(0, at - 30);
    ranked.push({
      id: n.id,
      title: n.title || 'Untitled',
      secure: n.secure,
      snippet: at < 0 ? '' : `${from > 0 ? '…' : ''}${n.body.slice(from, from + OFFLINE_SNIPPET).trim()}…`,
      rank: inTitle ? 0 : 1, // title matches first, then body matches
    });
  }
  return ranked.sort((a, b) => a.rank - b.rank).slice(0, 12);
}

/**
 * Full-text search over the vault. The Lucene endpoint has existed since the
 * search phase but nothing in the UI ever called it — this is that surface.
 * Cmd/Ctrl+K focuses it from anywhere; ↑/↓ walk the results; Enter opens one.
 */
export default function SearchBar() {
  const navigate = useNavigate();
  const { data: notes } = useNotes();
  const { online } = useSyncState();
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<Hit[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [offlineResults, setOfflineResults] = useState(false);
  // Index returned nothing but the raw text matched — results are substring-only.
  const [partial, setPartial] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  const cached = useMemo(() => notes ?? [], [notes]);

  const close = useCallback(() => { setOpen(false); setActive(0); }, []);

  // Debounced query. The local fallback runs synchronously so results never
  // disappear while the network attempt is in flight.
  useEffect(() => {
    const q = query.trim();
    if (!q) { setHits([]); setOfflineResults(false); return; }

    const local = searchLocally(cached, q);
    setHits(local);
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
          setHits(remote.slice(0, 12));
          setOfflineResults(false);
          setPartial(false);
        })
        .catch(() => { /* keep the local results — they're already on screen */ });
    }, DEBOUNCE_MS);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [query, cached, online]);

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

  function openHit(hit: Hit) {
    close();
    setQuery('');
    navigate(`/note/${encodeURIComponent(hit.id)}`);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Escape') { close(); inputRef.current?.blur(); return; }
    if (!hits.length) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => (a + 1) % hits.length); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => (a - 1 + hits.length) % hits.length); }
    else if (e.key === 'Enter') { e.preventDefault(); openHit(hits[active]); }
  }

  const showPanel = open && query.trim().length > 0;

  return (
    <div className={`search${showPanel ? ' search--open' : ''}`} ref={wrapRef}>
      <div className="search__field">
        <Search className="search__icon" size={16} aria-hidden="true" />
        <input
          ref={inputRef}
          className="search__input"
          type="search"
          value={query}
          placeholder="Search notes"
          aria-label="Search notes"
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
          {hits.length === 0 && <li className="search__empty">No matches.</li>}
          {hits.map((hit, i) => (
            <li key={hit.id}>
              <button
                type="button"
                role="option"
                aria-selected={i === active}
                className={`search__hit${i === active ? ' search__hit--active' : ''}`}
                onMouseEnter={() => setActive(i)}
                onClick={() => openHit(hit)}
              >
                <span className="search__hit-title">{hit.title || 'Untitled'}</span>
                {hit.secure
                  ? <span className="search__hit-snippet search__hit-snippet--locked">Locked note</span>
                  : hit.snippet && <span className="search__hit-snippet">{hit.snippet.replace(/<\/?[^>]+>/g, '')}</span>}
              </button>
            </li>
          ))}
          {offlineResults && hits.length > 0 && (
            <li className="search__note">Searching this device — full-text search resumes when the server is back.</li>
          )}
          {!offlineResults && partial && hits.length > 0 && (
            <li className="search__note">Close matches — nothing contains that word exactly.</li>
          )}
        </ul>
      )}
    </div>
  );
}
