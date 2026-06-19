import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { Link } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle, Pin, Archive, ArchiveRestore, Share2, Trash2, RotateCcw,
  MoreHorizontal, Copy, Link2,
} from 'lucide-react';
import type { Note } from '../types/note';
import { useSettings } from '../hooks/useSettings';
import ShareDialog from './ShareDialog';
import './NoteCard.css';

const SNIPPET_LEN = 220;

export type CardVariant = 'active' | 'archived' | 'trashed';

// Cards are plain-text previews (Keep-style), so flatten the markdown to readable
// prose instead of leaking raw syntax (#, **, ![[…]]) into the snippet.
function stripMarkdown(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, ' ')                    // fenced code blocks
    .replace(/`([^`]+)`/g, '$1')                        // inline code
    .replace(/!\[\[[^\]]*\]\]/g, ' ')                   // media embeds ![[file]]
    .replace(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g, '$1')   // wikilinks [[a|b]] → a
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')              // images ![alt](url)
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')            // links [text](url) → text
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')                 // headings
    .replace(/^\s{0,3}>\s?/gm, '')                      // blockquotes
    .replace(/^\s{0,3}[-*+]\s+\[[ xX]\]\s+/gm, '')      // task list markers
    .replace(/^\s{0,3}[-*+]\s+/gm, '')                  // bullet list markers
    .replace(/^\s{0,3}\d+\.\s+/gm, '')                  // ordered list markers
    .replace(/^\s{0,3}(?:[-*_]\s*){3,}$/gm, ' ')        // horizontal rules
    .replace(/(\*\*|__)(.*?)\1/g, '$2')                 // bold
    .replace(/(\*|_)(.*?)\1/g, '$2')                    // italic
    .replace(/~~(.*?)~~/g, '$2');                       // strikethrough
}

function snippet(body: string): string {
  const text = stripMarkdown(body).replace(/\s+/g, ' ').trim();
  return text.length > SNIPPET_LEN ? `${text.slice(0, SNIPPET_LEN)}…` : text;
}

interface Props {
  note: Note;
  variant?: CardVariant;
  // First unresolved conflict copy shadowing this note, if any, + how many there are.
  conflictId?: string;
  conflictCount?: number;
  onResolveConflict?: (conflictId: string) => void;
}

// Swallow a click on a card action so it doesn't bubble up to the Link (which
// would navigate into the note).
function stop(e: React.MouseEvent) {
  e.preventDefault();
  e.stopPropagation();
}

export default function NoteCard({ note, variant = 'active', conflictId, conflictCount, onResolveConflict }: Props) {
  const queryClient = useQueryClient();
  const { data: settings } = useSettings();
  const [menuOpen, setMenuOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);

  const title = note.title.trim() || 'Untitled';
  // YAML `color` drives the card surface via a CSS var so the stylesheet can dim
  // the (always-light) pastel toward surface in dark mode instead of glaring.
  const style = note.color ? ({ '--note-tint': note.color } as CSSProperties) : undefined;
  const className = `note-card${note.color ? ' note-card--colored' : ''}`;

  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [menuOpen]);

  function invalidate() { queryClient.invalidateQueries({ queryKey: ['notes'] }); }

  // Persist a frontmatter patch, preserving every field the card isn't changing.
  async function patchNote(patch: Partial<Note>) {
    const res = await fetch(`/api/notes/${encodeURIComponent(note.id)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: note.title, tags: note.tags, color: note.color,
        pinned: note.pinned, archived: note.archived, body: note.body,
        ...patch,
      }),
    });
    if (!res.ok) throw new Error(`PUT /api/notes/${note.id} failed: ${res.status}`);
    invalidate();
  }

  async function action(path: string, method = 'POST') {
    const res = await fetch(`/api/notes/${encodeURIComponent(note.id)}${path}`, { method });
    if (!res.ok && res.status !== 404) throw new Error(`${method} ${path} failed: ${res.status}`);
    invalidate();
  }

  // Soft-delete → trash. When retention is "immediate" (0), trashing can't be
  // recovered, so warn and hard-delete instead.
  async function trash() {
    if (settings?.trashRetentionDays === 0) {
      if (!confirm('Delete this note? Trash auto-delete is set to immediate — it cannot be recovered.')) return;
      await action('', 'DELETE');
      return;
    }
    await action('/trash');
  }

  async function deleteForever() {
    if (!confirm('Permanently delete this note? This cannot be recovered.')) return;
    await action('', 'DELETE');
  }

  async function duplicate() {
    const id = crypto.randomUUID();
    const res = await fetch(`/api/notes/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: title === 'Untitled' ? '' : `${note.title} copy`,
        tags: note.tags, color: note.color, pinned: false, archived: false, body: note.body,
      }),
    });
    if (!res.ok) throw new Error(`duplicate failed: ${res.status}`);
    invalidate();
  }

  async function copyLink() {
    const url = `${window.location.origin}/note/${encodeURIComponent(note.id)}`;
    try { await navigator.clipboard.writeText(url); } catch { /* clipboard blocked */ }
  }

  const card = (
    <article className={className} style={style}>
      {/* Keep-style pin: hangs off the top-right corner, half over the card. Only
          on active notes; always shown while pinned, else revealed on hover. */}
      {variant === 'active' && (
        <button
          type="button"
          className={`note-card__pin${note.pinned ? ' note-card__pin--active' : ''}`}
          aria-pressed={note.pinned}
          aria-label={note.pinned ? 'Unpin note' : 'Pin note'}
          onClick={(e) => { stop(e); void patchNote({ pinned: !note.pinned }); }}
        >
          <Pin size={15} fill={note.pinned ? 'currentColor' : 'none'} />
        </button>
      )}

      {conflictId && (
        <button
          type="button"
          className="note-card__conflict"
          onClick={(e) => { stop(e); onResolveConflict?.(conflictId); }}
        >
          <AlertTriangle size={14} />
          {conflictCount && conflictCount > 1
            ? `${conflictCount} sync conflicts — resolve`
            : 'Sync conflict — resolve'}
        </button>
      )}
      <h3 className="note-card__title">{title}</h3>
      {note.body.trim() && (
        <p className="note-card__snippet">{snippet(note.body)}</p>
      )}
      {note.tags.length > 0 && (
        <ul className="note-card__tags">
          {note.tags.map(tag => (
            <li key={tag} className="note-card__tag">{tag}</li>
          ))}
        </ul>
      )}

      <div className="note-card__actions">
        {variant === 'trashed' ? (
          <>
            <button
              type="button" className="note-card__action" aria-label="Restore note"
              onClick={(e) => { stop(e); void action('/untrash'); }}
            >
              <RotateCcw size={16} />
            </button>
            <button
              type="button" className="note-card__action note-card__action--danger" aria-label="Delete forever"
              onClick={(e) => { stop(e); void deleteForever(); }}
            >
              <Trash2 size={16} />
            </button>
          </>
        ) : (
          <>
            {variant === 'archived' ? (
              <button
                type="button" className="note-card__action" aria-label="Unarchive note"
                onClick={(e) => { stop(e); void patchNote({ archived: false }); }}
              >
                <ArchiveRestore size={16} />
              </button>
            ) : (
              <button
                type="button" className="note-card__action" aria-label="Archive note"
                onClick={(e) => { stop(e); void patchNote({ archived: true }); }}
              >
                <Archive size={16} />
              </button>
            )}
            <button
              type="button" className="note-card__action" aria-label="Share note"
              onClick={(e) => { stop(e); setMenuOpen(false); setShareOpen(true); }}
            >
              <Share2 size={16} />
            </button>
            <button
              type="button" className="note-card__action note-card__action--danger" aria-label="Delete note"
              onClick={(e) => { stop(e); void trash(); }}
            >
              <Trash2 size={16} />
            </button>
            <div className="note-card__menu-wrap" ref={menuRef}>
              <button
                type="button" className="note-card__action" aria-label="More actions"
                aria-expanded={menuOpen}
                onClick={(e) => { stop(e); setMenuOpen(o => !o); }}
              >
                <MoreHorizontal size={16} />
              </button>
              {menuOpen && (
                <div className="note-card__menu" role="menu">
                  <button
                    type="button" role="menuitem" className="note-card__menu-item"
                    onClick={(e) => { stop(e); setMenuOpen(false); void duplicate(); }}
                  >
                    <Copy size={15} /> Duplicate
                  </button>
                  <button
                    type="button" role="menuitem" className="note-card__menu-item"
                    onClick={(e) => { stop(e); setMenuOpen(false); void copyLink(); setShareOpen(true); }}
                  >
                    <Link2 size={15} /> Copy link
                  </button>
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </article>
  );

  return (
    <>
      {variant === 'trashed'
        ? <div className="note-card__link">{card}</div>
        : <Link to={`/note/${encodeURIComponent(note.id)}`} className="note-card__link">{card}</Link>}
      {shareOpen && <ShareDialog note={note} onClose={() => setShareOpen(false)} />}
    </>
  );
}
