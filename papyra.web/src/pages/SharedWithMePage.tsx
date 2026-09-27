import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import { X, Users, Eye, PencilLine, Clock } from 'lucide-react';
import { useIncomingShares, useRequestAccess, type IncomingShare } from '../hooks/useShares';
import { useResolvedTheme } from '../hooks/useTheme';
import { useDialogFocus } from '../hooks/useDialogFocus';
import { useToast } from '../lib/toastContext';
import { tintInkClass } from '../lib/noteColors';
import SharedNoteView, { type SharedNote } from '../components/SharedNoteView';
import Avatar from '../components/Avatar';
import MarkdownPreview from '../components/MarkdownPreview';
import { columnsFor } from '../lib/noteGridLayout';
import '../components/NoteCard.css';
import '../components/NoteGrid.css';
import EmptyState from '../components/EmptyState';
import LoadingBar from '../components/LoadingBar';
import './SharedWithMePage.css';

/**
 * Notes other people have shared with you. The cards are the notes page's own
 * cards — same width, same masonry, same colour exactly as the owner set it —
 * with who shared it and what you may do with it along the bottom.
 * `?open=<shareId>` (the desk's rail, the bell) opens one straight away.
 */
export default function SharedWithMePage() {
  const { data: incoming, isLoading } = useIncomingShares();
  const [params, setParams] = useSearchParams();
  const openId = Number(params.get('open')) || null;

  const setOpen = (id: number | null) => {
    const next = new URLSearchParams(params);
    if (id == null) next.delete('open'); else next.set('open', String(id));
    setParams(next, { replace: id == null });
  };

  const count = incoming?.length ?? 0;

  return (
    <section className="shared-with">
      <header className="shared-with__head">
        <h1 className="page-title">Shared with me</h1>
        {count > 0 && (
          <p className="shared-with__lede">
            {count} {count === 1 ? 'note' : 'notes'} from other people. Edits you make land in their note, and they see them straight away.
          </p>
        )}
      </header>

      {isLoading && <LoadingBar label="Loading shared notes" />}
      {!isLoading && count === 0 && (
        <EmptyState
          icon={Users}
          title="Nothing shared with you yet"
          body="When someone on this server shares a note with you, it appears here. Depending on what they chose, you will either be able to read it or edit it alongside them."
          hint="Only the notes they picked are shared — nobody can see the rest of your notes, and you cannot see the rest of theirs."
        />
      )}

      {count > 0 && <SharedGrid shares={incoming!} />}

      {openId != null && <SharedModal shareId={openId} onClose={() => setOpen(null)} />}
    </section>
  );
}

/**
 * Masonry with the desk's column maths (columnsFor: ~250px columns, 16px gap),
 * so a shared card is the same width as one of your own at the same window size.
 */
function SharedGrid({ shares }: { shares: IncomingShare[] }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);
  // Measured before paint (no one-column flash), then kept in step with the
  // window. ResizeObserver alone waits for a rendering frame, which a
  // background tab may never give it.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.clientWidth);
    const ro = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  // Container width + one column's padding, since .note-grid pulls itself
  // left by the gap; columnsFor then yields exactly the desk's column width.
  const { cols } = columnsFor(width);
  // Round-robin into columns, the same order react-masonry-css uses elsewhere.
  const columns: IncomingShare[][] = Array.from({ length: cols }, () => []);
  shares.forEach((s, i) => columns[i % cols].push(s));

  return (
    <div ref={ref} className="note-grid-wrap">
      {width > 0 && (
        <div className="note-grid">
          {columns.map((col, i) => (
            <div key={i} className="note-grid__col" style={{ width: `${100 / cols}%` }}>
              {col.map(s => <SharedCard key={s.shareId} share={s} />)}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function SharedCard({ share }: { share: IncomingShare }) {
  const theme = useResolvedTheme();
  const [params] = useSearchParams();
  // Same paint as NoteCard: the owner's colour through --note-tint, mixed by
  // --tint-strength so dark mode mutes it exactly as it does on the desk.
  const style = share.color ? ({ '--note-tint': share.color } as CSSProperties) : undefined;
  const className = `note-card shared-card${share.color ? ` note-card--colored${tintInkClass(share.color, theme)}` : ''}`;
  const title = share.title.trim() || 'Untitled';
  const next = new URLSearchParams(params);
  next.set('open', String(share.shareId));

  return (
    <Link
      to={{ search: next.toString() }}
      className="note-card__link"
      aria-label={`${title}, shared by @${share.owner}, ${share.access === 'edit' ? 'you can edit' : 'view only'}`}
    >
      <article className={className} style={style}>
        <h3 className="note-card__title">{title}</h3>
        {share.body.trim() && <MarkdownPreview body={share.body} />}
        <div className="shared-card__foot">
          <span className="shared-card__owner">
            <Avatar username={share.owner} name={share.owner} size={20} />
            <span className="shared-card__owner-name">@{share.owner}</span>
          </span>
          {share.access === 'edit' ? (
            <span className="shared-card__chip shared-card__chip--edit"><PencilLine size={12} aria-hidden="true" /> Can edit</span>
          ) : share.requestPending ? (
            <span className="shared-card__chip"><Clock size={12} aria-hidden="true" /> Edit requested</span>
          ) : (
            <span className="shared-card__chip"><Eye size={12} aria-hidden="true" /> View only</span>
          )}
        </div>
      </article>
    </Link>
  );
}

function SharedModal({ shareId, onClose }: { shareId: number; onClose: () => void }) {
  const ref = useRef<HTMLDivElement | null>(null);
  useDialogFocus(ref);
  const queryClient = useQueryClient();
  const request = useRequestAccess();
  const { toast } = useToast();

  // Under ['shares', 'incoming'] so an approval pushed over the hub (which
  // invalidates that prefix) refetches the open note and flips it editable.
  const { data: note, isError } = useQuery({
    queryKey: ['shares', 'incoming', shareId],
    queryFn: async (): Promise<SharedNote> => {
      const res = await fetch(`/api/shares/incoming/${shareId}`);
      if (!res.ok) throw new Error(res.status === 410 ? 'The owner locked this note.' : 'This note is no longer shared with you.');
      return res.json();
    },
    retry: false,
    // An editor is live on screen; a background refetch must not replace it
    // unless the access itself changed (the editor is keyed on that).
    refetchOnWindowFocus: false,
  });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  async function save(body: string) {
    const res = await fetch(`/api/shares/incoming/${shareId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body }),
    });
    if (!res.ok) throw new Error(`save failed: ${res.status}`);
  }

  async function requestEdit() {
    try {
      await request.mutateAsync({ shareId, access: 'edit' });
      await queryClient.invalidateQueries({ queryKey: ['shares', 'incoming', shareId] });
      toast(`Asked ${note?.owner ? `@${note.owner}` : 'the owner'} for edit access.`);
    } catch (e) { toast((e as Error).message); }
  }

  return (
    <div className="shared-with__modal" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={ref} className="shared-with__modal-inner" role="dialog" aria-modal="true" aria-label={note?.title || 'Shared note'}>
        <button type="button" className="shared-with__close" aria-label="Close" onClick={onClose}>
          <X size={18} />
        </button>
        {isError && <p className="shared-with__status">This note is no longer shared with you.</p>}
        {!isError && (note ? (
          <SharedNoteView
            note={note}
            onSave={save}
            onRequestEdit={requestEdit}
            mediaUrl={(f) => `/api/shares/incoming/${shareId}/media/${encodeURIComponent(f)}`}
          />
        ) : <LoadingBar label="Loading shared note" />)}
      </div>
    </div>
  );
}
