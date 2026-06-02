import { useEffect, useRef, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  MagnifyingGlass, FileText, Tag, Archive, Trash,
  Gear, ShieldCheck, Moon, Sun,
} from '@phosphor-icons/react';
import { useLayout } from '../context/LayoutContext';
import { useSearchNotes } from '../hooks/useNotes';
import { useDebounce } from '../hooks/useDebounce';
import { useTheme } from '../hooks/useTheme';
import type { SearchHit } from '../types';
import './SearchPalette.css';

type NavAction = {
  id: string;
  label: string;
  icon: React.ComponentType<{ size?: number; 'aria-hidden'?: boolean | 'true' }>;
  keywords: string[];
  action: () => void;
};

export default function SearchPalette() {
  const { isSearchOpen, openSearch, closeSearch } = useLayout();
  const { theme, toggleTheme } = useTheme();
  const navigate = useNavigate();

  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef  = useRef<HTMLDivElement>(null);

  const debouncedQuery = useDebounce(query.trim(), 150);
  const { data: noteResults = [], isFetching } = useSearchNotes(debouncedQuery);

  // ── Navigation actions ──────────────────────────────────────────────
  const navActions: NavAction[] = [
    {
      id: 'nav-notes', label: 'Go to Notes', icon: FileText,
      keywords: ['notes', 'home'],
      action: () => { navigate('/'); closeSearch(); },
    },
    {
      id: 'nav-categories', label: 'Go to Categories', icon: Tag,
      keywords: ['categories', 'tags'],
      action: () => { navigate('/categories'); closeSearch(); },
    },
    {
      id: 'nav-archive', label: 'Go to Archive', icon: Archive,
      keywords: ['archive'],
      action: () => { navigate('/archive'); closeSearch(); },
    },
    {
      id: 'nav-trash', label: 'Go to Trash', icon: Trash,
      keywords: ['trash', 'deleted'],
      action: () => { navigate('/trash'); closeSearch(); },
    },
    {
      id: 'nav-settings', label: 'Go to Settings', icon: Gear,
      keywords: ['settings', 'preferences', 'config'],
      action: () => { navigate('/settings'); closeSearch(); },
    },
    {
      id: 'nav-admin', label: 'Go to Admin Panel', icon: ShieldCheck,
      keywords: ['admin', 'panel', 'manage'],
      action: () => { navigate('/admin'); closeSearch(); },
    },
    {
      id: 'nav-theme',
      label: `Switch to ${theme === 'light' ? 'Dark' : 'Light'} Mode`,
      icon: theme === 'light' ? Moon : Sun,
      keywords: ['theme', 'dark', 'light', 'mode', 'appearance'],
      action: () => { toggleTheme(); closeSearch(); },
    },
  ];

  const filteredNav = debouncedQuery
    ? navActions.filter(a =>
        a.label.toLowerCase().includes(debouncedQuery.toLowerCase()) ||
        a.keywords.some(k => k.includes(debouncedQuery.toLowerCase()))
      )
    : navActions;

  const totalItems = noteResults.length + filteredNav.length;

  // ── Global Cmd/Ctrl+K shortcut ──────────────────────────────────────
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        isSearchOpen ? closeSearch() : openSearch();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [isSearchOpen, openSearch, closeSearch]);

  // ── Reset state when opened ─────────────────────────────────────────
  useEffect(() => {
    if (isSearchOpen) {
      setQuery('');
      setActiveIndex(0);
      // Defer focus so the element is in the DOM
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [isSearchOpen]);

  // ── Reset active index when results change ──────────────────────────
  useEffect(() => {
    setActiveIndex(0);
  }, [debouncedQuery]);

  // ── Scroll active item into view ────────────────────────────────────
  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>('[data-active="true"]')
      ?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex]);

  const activateItem = useCallback(
    (index: number) => {
      if (index < noteResults.length) {
        navigate(`/?open=${noteResults[index].id}`);
        closeSearch();
      } else {
        filteredNav[index - noteResults.length]?.action();
      }
    },
    [noteResults, filteredNav, navigate, closeSearch],
  );

  // ── Keyboard navigation inside palette ─────────────────────────────
  useEffect(() => {
    if (!isSearchOpen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        closeSearch();
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActiveIndex(i => Math.min(i + 1, totalItems - 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActiveIndex(i => Math.max(i - 1, 0));
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (totalItems > 0) activateItem(activeIndex);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [isSearchOpen, closeSearch, activeIndex, totalItems, activateItem]);

  if (!isSearchOpen) return null;

  const showNotes  = noteResults.length > 0;
  const showNav    = filteredNav.length > 0;
  const showEmpty  = debouncedQuery.length > 0 && !isFetching && !showNotes && !showNav;

  return (
    <div className="search-palette" role="dialog" aria-modal="true" aria-label="Search">
      <div className="search-palette__backdrop" onClick={closeSearch} aria-hidden="true" />

      <div className="search-palette__card">
        {/* ── Input ── */}
        <div className="search-palette__input-row">
          <MagnifyingGlass size={18} className="search-palette__input-icon" aria-hidden="true" />
          <input
            ref={inputRef}
            className="search-palette__input"
            type="text"
            placeholder="Search notes or type a command…"
            value={query}
            onChange={e => setQuery(e.target.value)}
            autoComplete="off"
            spellCheck={false}
            aria-label="Search"
            role="combobox"
            aria-expanded={true}
            aria-autocomplete="list"
          />
          {isFetching && <span className="search-palette__spinner" aria-label="Searching…" />}
          <kbd className="search-palette__esc-hint">esc</kbd>
        </div>

        {/* ── Results ── */}
        <div className="search-palette__results" ref={listRef} role="listbox">
          {/* Notes section */}
          {showNotes && (
            <section className="search-palette__section">
              <h3 className="search-palette__section-label">Notes</h3>
              {(noteResults as SearchHit[]).map((note, i) => (
                <button
                  key={note.id}
                  className={`search-palette__item${i === activeIndex ? ' search-palette__item--active' : ''}`}
                  data-active={i === activeIndex || undefined}
                  role="option"
                  aria-selected={i === activeIndex}
                  onClick={() => activateItem(i)}
                  onMouseEnter={() => setActiveIndex(i)}
                >
                  <FileText size={15} className="search-palette__item-icon" aria-hidden="true" />
                  <span className="search-palette__item-title">{note.title}</span>
                  {note.snippet && (
                    <span className="search-palette__item-snippet">{note.snippet}</span>
                  )}
                </button>
              ))}
            </section>
          )}

          {/* Navigation / actions section */}
          {showNav && (
            <section className="search-palette__section">
              <h3 className="search-palette__section-label">
                {debouncedQuery ? 'Actions & Navigation' : 'Quick Navigation'}
              </h3>
              {filteredNav.map((action, i) => {
                const absIndex = noteResults.length + i;
                const Icon = action.icon;
                return (
                  <button
                    key={action.id}
                    className={`search-palette__item${absIndex === activeIndex ? ' search-palette__item--active' : ''}`}
                    data-active={absIndex === activeIndex || undefined}
                    role="option"
                    aria-selected={absIndex === activeIndex}
                    onClick={() => activateItem(absIndex)}
                    onMouseEnter={() => setActiveIndex(absIndex)}
                  >
                    <Icon size={15} className="search-palette__item-icon" aria-hidden={true} />
                    <span className="search-palette__item-title">{action.label}</span>
                  </button>
                );
              })}
            </section>
          )}

          {/* Empty state */}
          {showEmpty && (
            <p className="search-palette__empty">No results for "{debouncedQuery}"</p>
          )}
        </div>
      </div>
    </div>
  );
}
