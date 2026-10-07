import { useEffect } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import type { Note } from '../types/note';

/**
 * "Take me to this note": from a search result to the card, on the page the note
 * actually lives on.
 *
 * Opening a hit shows the note over whatever page you happen to be on, which says
 * nothing about where it belongs — an archived note opens over the Notes desk.
 * This does the other thing: go to the page that holds it, scroll its card into
 * view and pulse it once. The page learns which card via `?locate=<id>`.
 */

export interface NoteLocation {
  /** Where the note lives, as the sidebar names it. */
  label: string;
  /** The page that lists it. */
  path: string;
}

/** The page a note is listed on, from the same rules the pages filter by. */
export function noteLocation(note: Pick<Note, 'archived' | 'trashed' | 'kind' | 'secure'>): NoteLocation {
  if (note.trashed) return { label: 'Trash', path: '/trash' };
  if (note.archived) return { label: 'Archive', path: '/archive' };
  if (note.kind === 'inbox') return { label: 'Inbox', path: '/inbox' };
  if (note.kind === 'todo') return { label: 'To Do', path: '/todo' };
  if (note.secure) return { label: 'Vault', path: '/vault' };
  return { label: 'Notes', path: '/' };
}

export function locateHref(id: string, loc: NoteLocation): string {
  return `${loc.path}?locate=${encodeURIComponent(id)}`;
}

/** The card a page was asked to reveal, if any. */
export function useLocateId(): string | null {
  const { search } = useLocation();
  return new URLSearchParams(search).get('locate');
}

// How long to wait for the card to show up (a list still loading, a reveal batch).
const GIVE_UP_MS = 6000;
// Cards settle into their masonry slots a beat after they mount; scrolling any
// sooner aims at a position that is about to move.
const SETTLE_MS = 350;
const PULSE_MS = 1600;

/**
 * Watches for `?locate=<id>`: once that note's card is on the page, scrolls it to
 * the middle of the desk and pulses it. The parameter is then dropped, so a
 * reload or a shared link doesn't replay it. Renders nothing.
 */
export function useLocateEffect() {
  const { pathname, search } = useLocation();
  const navigate = useNavigate();
  const id = new URLSearchParams(search).get('locate');

  useEffect(() => {
    if (!id) return;
    const selector = `[data-note-id="${CSS.escape(id)}"]`;
    const desk = document.querySelector('.workspace__desk') ?? document.body;
    let settle: ReturnType<typeof setTimeout> | undefined;
    let clear: ReturnType<typeof setTimeout> | undefined;
    let target: Element | null = null;

    const strip = () => {
      const next = new URLSearchParams(search);
      next.delete('locate');
      const q = next.toString();
      navigate(pathname + (q ? `?${q}` : ''), { replace: true });
    };

    const reveal = () => {
      const el = document.querySelector(selector);
      if (!el) { strip(); return; }
      target = el;
      el.scrollIntoView({ block: 'center', behavior: 'auto' });
      el.classList.add('is-located');
      clear = setTimeout(() => el.classList.remove('is-located'), PULSE_MS);
      strip();
    };

    const found = () => {
      if (settle || !document.querySelector(selector)) return;
      mo.disconnect();
      clearTimeout(giveUp);
      settle = setTimeout(reveal, SETTLE_MS);
    };
    const mo = new MutationObserver(found);
    mo.observe(desk, { childList: true, subtree: true });
    const giveUp = setTimeout(() => { mo.disconnect(); strip(); }, GIVE_UP_MS);
    found();

    return () => {
      mo.disconnect();
      clearTimeout(giveUp);
      clearTimeout(settle);
      // The strip() above navigates, which re-runs this cleanup: leave the pulse
      // to finish on its own timer rather than cutting it off.
      if (!target) clearTimeout(clear);
    };
    // Keyed on the id alone — the effect strips `locate` from the URL itself.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);
}
