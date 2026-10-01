import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { MessageSquarePlus, MessageSquareText, X } from 'lucide-react';
import Avatar from '../Avatar';
import CommentComposer from './CommentComposer';
import CommentThreadView from './CommentThreadView';
import { buildTextIndex, quoteFromRange, rangeForQuote, type TextQuote } from '../../lib/textAnchor';
import { useToast } from '../../lib/toastContext';
import type { CommentThread, useComments } from '../../hooks/useComments';
import './comments.css';

type Api = ReturnType<typeof useComments>;

const HOVER_SHOW_MS = 180;
const HOVER_HIDE_MS = 260;
const CARD_WIDTH = 340;
const RAIL_MIN = 240;
const RAIL_MAX = 320;
const RAIL_GAP = 24;

/** The Custom Highlight API, where the browser has it (Chrome 105+, Safari 17.2+, Firefox 140+). */
type HighlightCtor = new (...ranges: Range[]) => { add(r: Range): void };
function highlights(): { set(name: string, h: unknown): void; delete(name: string): void } | null {
  const css = (globalThis as { CSS?: { highlights?: { set(n: string, h: unknown): void; delete(n: string): void } } }).CSS;
  return css?.highlights && 'Highlight' in globalThis ? css.highlights : null;
}
const Highlight = (globalThis as unknown as { Highlight?: HighlightCtor }).Highlight;

function rectsContain(range: Range, x: number, y: number): boolean {
  for (const r of range.getClientRects()) {
    if (x >= r.left - 1 && x <= r.right + 1 && y >= r.top - 1 && y <= r.bottom + 1) return true;
  }
  return false;
}

/** Where a floating card goes: under the passage, or over it when there's no room below. */
function placeCard(anchor: DOMRect, height = 260): { top: number; left: number; above: boolean } {
  const above = anchor.bottom + height + 12 > window.innerHeight && anchor.top > height + 12;
  return {
    top: above ? anchor.top - 8 : anchor.bottom + 8,
    left: Math.min(Math.max(8, anchor.left), window.innerWidth - CARD_WIDTH - 8),
    above,
  };
}

/**
 * Comments on the open note, Google-Docs style, without taking any room from
 * the note itself:
 *
 * - Commented passages are tinted in place (CSS Custom Highlight API — no DOM
 *   or document changes, so the editor and the live room never see them).
 * - In the normal note window, hovering a tinted passage shows its thread in a
 *   card; clicking pins it open to reply.
 * - In focus (full-screen) mode, where the page has empty margins, every open
 *   thread sits in a rail beside the note, level with its passage.
 * - Selecting text offers "Comment" (or Ctrl+Alt+M).
 * - The panel (header button) lists everything, including resolved threads
 *   and ones whose passage was edited away ("detached").
 */
export default function NoteComments({
  api, rootEl, sheetRef, focusMode, panelOpen, onPanelOpen, onPanelClose, openThreadId,
}: {
  api: Api;
  /** The editor's contenteditable root. */
  rootEl: HTMLElement | null;
  /** The note sheet: the focus-mode rail sits beside it. */
  sheetRef: RefObject<HTMLElement | null>;
  focusMode: boolean;
  panelOpen: boolean;
  onPanelOpen: () => void;
  onPanelClose: () => void;
  /** Bring this thread into view once loaded (a notification's "Open"). */
  openThreadId?: number | null;
}) {
  const data = api.data;
  const { toast } = useToast();
  const [anchors, setAnchors] = useState<Map<number, Range>>(new Map());
  // The note text the anchors were found in — so "not found" is only believed
  // once the note has actually rendered (a live note syncs after mount).
  const [anchoredText, setAnchoredText] = useState<string | null>(null);
  const [active, setActive] = useState<number | null>(null);
  const [hover, setHover] = useState<number | null>(null);
  const [draft, setDraft] = useState<{ quote: TextQuote; range: Range } | null>(null);
  const [bubble, setBubble] = useState<{ range: Range; top: number; left: number } | null>(null);
  const [railBox, setRailBox] = useState<{ left: number; width: number } | null>(null);
  const [, setFrame] = useState(0); // re-render floating cards on scroll/resize
  const showTimer = useRef<number | undefined>(undefined);
  const hideTimer = useRef<number | undefined>(undefined);
  const railRef = useRef<HTMLDivElement | null>(null);

  const threads = useMemo(() => data?.threads ?? [], [data]);
  const open = threads.filter(t => !t.resolved);
  const rail = focusMode && railBox !== null;

  // ── Find every open thread's passage; again whenever the note changes ─────
  useEffect(() => {
    if (!rootEl || threads.length === 0) { setAnchors(new Map()); return; }
    let timer: number | undefined;
    const run = () => {
      const index = buildTextIndex(rootEl);
      const next = new Map<number, Range>();
      for (const t of threads) {
        if (t.resolved || !t.quote) continue;
        const r = rangeForQuote(index, t.quote);
        if (r) next.set(t.id, r);
      }
      setAnchors(next);
      setAnchoredText(index.text);
    };
    run();
    // Typing, a remote edit arriving through the room, a remount: re-anchor.
    const observer = new MutationObserver(() => { window.clearTimeout(timer); timer = window.setTimeout(run, 150); });
    observer.observe(rootEl, { subtree: true, childList: true, characterData: true });
    return () => { observer.disconnect(); window.clearTimeout(timer); };
  }, [rootEl, threads]);

  // ── Paint ───────────────────────────────────────────────────────────────────
  const focus = active ?? hover;
  useEffect(() => {
    const registry = highlights();
    if (!registry || !Highlight) return;
    const quiet = [...anchors].filter(([id]) => id !== focus).map(([, r]) => r);
    const lit = new Highlight();
    if (focus !== null && anchors.get(focus)) lit.add(anchors.get(focus)!);
    if (draft) lit.add(draft.range);
    registry.set('papyra-comment', new Highlight(...quiet));
    registry.set('papyra-comment-active', lit);
    return () => { registry.delete('papyra-comment'); registry.delete('papyra-comment-active'); };
  }, [anchors, focus, draft]);

  const threadAt = useCallback((x: number, y: number): number | null => {
    for (const [id, r] of anchors) if (rectsContain(r, x, y)) return id;
    return null;
  }, [anchors]);

  // ── Focus mode: is there room for a rail beside the sheet? ─────────────────
  useEffect(() => {
    const sheetEl = sheetRef.current;
    if (!focusMode || !sheetEl) { setRailBox(null); return; }
    const measure = () => {
      const right = sheetEl.getBoundingClientRect().right;
      const width = Math.min(RAIL_MAX, window.innerWidth - right - RAIL_GAP * 2);
      setRailBox(width >= RAIL_MIN ? { left: right + RAIL_GAP, width } : null);
    };
    measure();
    // The sheet (its width) and the page (the room beside it).
    const ro = new ResizeObserver(measure);
    ro.observe(sheetEl);
    ro.observe(document.documentElement);
    window.addEventListener('resize', measure);
    return () => { ro.disconnect(); window.removeEventListener('resize', measure); };
  }, [focusMode, sheetRef]);

  // ── Scrolling moves passages: follow them ──────────────────────────────────
  useEffect(() => {
    let raf = 0;
    const onScroll = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => setFrame(f => f + 1));
      // A hover card is a glance; scrolling ends it. A pinned one follows.
      window.clearTimeout(showTimer.current);
      setHover(null);
    };
    // Capture: scroll doesn't bubble, and the scroller may be the note sheet,
    // a modal around it, or the page.
    window.addEventListener('scroll', onScroll, { passive: true, capture: true });
    window.addEventListener('resize', onScroll);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('scroll', onScroll, { capture: true });
      window.removeEventListener('resize', onScroll);
    };
  }, []);

  // ── Hover a passage → its card (normal window only) ────────────────────────
  useEffect(() => {
    if (!rootEl) return;
    const onMove = (e: MouseEvent) => {
      const id = threadAt(e.clientX, e.clientY);
      rootEl.classList.toggle('has-comment-hover', id !== null);
      if (rail) return;
      if (id !== null) {
        window.clearTimeout(hideTimer.current);
        if (id !== hover) {
          window.clearTimeout(showTimer.current);
          showTimer.current = window.setTimeout(() => setHover(id), HOVER_SHOW_MS);
        }
      } else if (hover !== null) {
        window.clearTimeout(showTimer.current);
        window.clearTimeout(hideTimer.current);
        hideTimer.current = window.setTimeout(() => setHover(null), HOVER_HIDE_MS);
      } else {
        window.clearTimeout(showTimer.current);
      }
    };
    const onLeave = () => {
      window.clearTimeout(showTimer.current);
      hideTimer.current = window.setTimeout(() => setHover(null), HOVER_HIDE_MS);
    };
    const onClick = (e: MouseEvent) => {
      const id = threadAt(e.clientX, e.clientY);
      if (id !== null && window.getSelection()?.isCollapsed !== false) { setActive(id); setHover(null); }
    };
    rootEl.addEventListener('mousemove', onMove);
    rootEl.addEventListener('mouseleave', onLeave);
    rootEl.addEventListener('click', onClick);
    return () => {
      rootEl.removeEventListener('mousemove', onMove);
      rootEl.removeEventListener('mouseleave', onLeave);
      rootEl.removeEventListener('click', onClick);
      rootEl.classList.remove('has-comment-hover');
    };
  }, [rootEl, threadAt, hover, rail]);

  // ── Select text → "Comment" ────────────────────────────────────────────────
  useEffect(() => {
    if (!rootEl || !data) return;
    let timer: number | undefined;
    const onChange = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        const sel = document.getSelection();
        if (!sel || sel.isCollapsed || sel.rangeCount === 0) { setBubble(null); return; }
        const range = sel.getRangeAt(0);
        if (!rootEl.contains(range.commonAncestorContainer) || !range.toString().trim()) { setBubble(null); return; }
        const rects = range.getClientRects();
        const last = rects[rects.length - 1] ?? range.getBoundingClientRect();
        setBubble({ range: range.cloneRange(), top: last.top, left: last.right });
      }, 180);
    };
    document.addEventListener('selectionchange', onChange);
    return () => { document.removeEventListener('selectionchange', onChange); window.clearTimeout(timer); };
  }, [rootEl, data]);

  // luthor's formatting bubble over the same selection (it portals into the
  // editor's wrapper): Comment joins it as one more button rather than floating
  // a second pill beside it. Without one (a read-only view), the pill it is.
  const barHost = rootEl?.closest<HTMLElement>('.luthor-editor-wrapper') ?? null;
  const watchBar = useCallback((notify: () => void) => {
    if (!barHost) return () => {};
    const observer = new MutationObserver(notify);
    observer.observe(barHost, { childList: true });
    return () => observer.disconnect();
  }, [barHost]);
  const selectionBar = useSyncExternalStore(watchBar,
    () => barHost?.querySelector<HTMLElement>(':scope > .luthor-floating-toolbar') ?? null);

  const startDraft = useCallback((range: Range) => {
    if (!rootEl) return;
    const quote = quoteFromRange(buildTextIndex(rootEl), range);
    if (!quote) return;
    if (quote.exact.length > 500) { toast('Select less text to comment on — up to 500 characters.'); return; }
    setBubble(null);
    setActive(null);
    setHover(null);
    setDraft({ quote, range });
  }, [rootEl, toast]);

  // ── Keys: Ctrl+Alt+M comments on the selection; Escape closes ours first ───
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === 'm' && e.altKey && (e.ctrlKey || e.metaKey) && bubble) {
        e.preventDefault();
        startDraft(bubble.range);
        return;
      }
      if (e.key !== 'Escape') return;
      // A comment box handles its own Escape (and stops it).
      if ((e.target as Element | null)?.closest?.('.comment-ui')) return;
      if (draft) setDraft(null);
      else if (active !== null) setActive(null);
      else if (panelOpen) onPanelClose();
      else return;
      e.preventDefault();
      e.stopImmediatePropagation();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [bubble, draft, active, panelOpen, onPanelClose, startDraft]);

  // ── A click anywhere else lets go of a pinned card ─────────────────────────
  useEffect(() => {
    if (active === null) return;
    const onDown = (e: MouseEvent) => {
      if ((e.target as Element | null)?.closest?.('.comment-ui')) return;
      if (threadAt(e.clientX, e.clientY) !== null) return;
      setActive(null);
    };
    document.addEventListener('mousedown', onDown, true);
    return () => document.removeEventListener('mousedown', onDown, true);
  }, [active, threadAt]);

  // ── Deep link from a notification ──────────────────────────────────────────
  const opened = useRef<number | null>(null);
  useEffect(() => {
    if (!openThreadId || opened.current === openThreadId || !data) return;
    const thread = threads.find(t => t.id === openThreadId);
    if (!thread) return;
    const range = anchors.get(openThreadId);
    // A passage we haven't looked for in the rendered note yet: wait, rather
    // than call it detached and open the panel.
    if (!range && !thread.resolved && thread.quote && (!anchoredText?.trim() || !rootEl)) return;
    opened.current = openThreadId;
    if (range) {
      range.startContainer.parentElement?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      setActive(openThreadId);
    } else {
      onPanelOpen();
    }
  }, [openThreadId, data, threads, anchors, anchoredText, rootEl, onPanelOpen]);

  const jumpTo = useCallback((t: CommentThread) => {
    const range = anchors.get(t.id);
    if (!range) return;
    range.startContainer.parentElement?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    setActive(t.id);
  }, [anchors]);

  // ── Focus-mode rail: cards level with their passages, never overlapping ────
  useLayoutEffect(() => {
    const el = railRef.current;
    if (!rail || !el) return;
    const cards = [...el.querySelectorAll<HTMLElement>('[data-anchor]')];
    const items = cards.map(card => {
      const id = card.dataset.anchor!;
      const range = id === 'draft' ? draft?.range : anchors.get(Number(id));
      const top = range?.getBoundingClientRect().top ?? NaN;
      return { card, top, h: card.offsetHeight, key: id };
    }).filter(i => Number.isFinite(i.top)).sort((a, b) => a.top - b.top);
    const pos = items.map(i => i.top);
    // Forward: push down past the card above.
    for (let i = 1; i < items.length; i++) pos[i] = Math.max(pos[i], pos[i - 1] + items[i - 1].h + 10);
    // The card in use sits exactly level with its passage; the ones above make room.
    const k = items.findIndex(i => i.key === 'draft' || i.key === String(active));
    if (k >= 0) {
      pos[k] = items[k].top;
      for (let i = k - 1; i >= 0; i--) pos[i] = Math.min(pos[i], pos[i + 1] - items[i].h - 10);
      for (let i = k + 1; i < items.length; i++) pos[i] = Math.max(items[i].top, pos[i - 1] + items[i - 1].h + 10);
    }
    items.forEach((i, n) => { i.card.style.transform = `translateY(${Math.round(pos[n])}px)`; i.card.style.visibility = 'visible'; });
  });

  if (!data) return null;

  const people = data.people;
  const hoverThread = !rail && hover !== null && active === null ? threads.find(t => t.id === hover) : undefined;
  const pinnedThread = !rail && active !== null ? threads.find(t => t.id === active) : undefined;
  const floatThread = pinnedThread ?? hoverThread;
  const floatRange = floatThread ? anchors.get(floatThread.id) : undefined;

  const composer = draft && (
    <div className="comment-card comment-card--draft">
      <blockquote className="comment-thread__quote">{draft.quote.exact}</blockquote>
      <CommentComposer
        people={people}
        placeholder="Add a comment"
        submitLabel="Comment"
        autoFocus
        busy={api.create.isPending}
        onSubmit={async (body) => {
          const res = await api.create.mutateAsync({ body, quote: draft.quote });
          setDraft(null);
          window.getSelection()?.removeAllRanges();
          setActive(res.threadId);
        }}
        onCancel={() => setDraft(null)}
      />
    </div>
  );

  return (
    <>
      {/* "Comment" on a selection: in the formatting bubble, else beside it. */}
      {bubble && !draft && selectionBar && createPortal(
        <>
          <div className="luthor-floating-toolbar-separator" />
          <button
            type="button"
            className="luthor-toolbar-button comment-ui comment-tool"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => startDraft(bubble.range)}
            title="Comment (Ctrl+Alt+M)"
            aria-label="Comment"
          >
            <MessageSquarePlus size={14} aria-hidden="true" />
          </button>
        </>,
        selectionBar,
      )}
      {bubble && !draft && !selectionBar && createPortal(
        <button
          type="button"
          className="comment-ui comment-bubble"
          style={{ top: Math.max(8, bubble.top - 40), left: Math.min(bubble.left - 16, window.innerWidth - 130) }}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => startDraft(bubble.range)}
          title="Comment (Ctrl+Alt+M)"
        >
          <MessageSquarePlus size={15} aria-hidden="true" /> Comment
        </button>,
        document.body,
      )}

      {/* Normal window: the hovered or pinned thread, over the passage. */}
      {!rail && floatThread && floatRange && createPortal(
        (() => {
          const p = placeCard(floatRange.getBoundingClientRect());
          return (
            <div
              className={`comment-ui comment-card comment-card--float${p.above ? ' is-above' : ''}${pinnedThread ? ' is-pinned' : ''}`}
              style={{ top: p.top, left: p.left, width: CARD_WIDTH }}
              onMouseEnter={() => window.clearTimeout(hideTimer.current)}
              onMouseLeave={() => { if (!pinnedThread) hideTimer.current = window.setTimeout(() => setHover(null), HOVER_HIDE_MS); }}
              onMouseDown={() => { if (!pinnedThread) { setActive(floatThread.id); setHover(null); } }}
              role="dialog"
              aria-label="Comment thread"
            >
              <CommentThreadView thread={floatThread} data={data} api={api} onClosed={() => { setActive(null); setHover(null); }} />
            </div>
          );
        })(),
        document.body,
      )}

      {/* Normal window: the new-comment box, under the selection. */}
      {!rail && draft && createPortal(
        (() => {
          const p = placeCard(draft.range.getBoundingClientRect(), 200);
          return (
            <div className={`comment-ui comment-float-host${p.above ? ' is-above' : ''}`} style={{ top: p.top, left: p.left, width: CARD_WIDTH }}>
              {composer}
            </div>
          );
        })(),
        document.body,
      )}

      {/* Focus mode: the margin rail. */}
      {rail && railBox && createPortal(
        <div ref={railRef} className="comment-ui comment-rail" style={{ left: railBox.left, width: railBox.width }} aria-label="Comments">
          {draft && <div className="comment-rail__item" data-anchor="draft">{composer}</div>}
          {open.filter(t => anchors.has(t.id)).map(t => (
            <div key={t.id} className="comment-rail__item" data-anchor={t.id}>
              {active === t.id ? (
                <div className="comment-card is-pinned">
                  <CommentThreadView thread={t} data={data} api={api} autoFocusReply={false} onClosed={() => setActive(null)} />
                </div>
              ) : (
                <button type="button" className="comment-card comment-card--summary" onClick={() => setActive(t.id)}
                  onMouseEnter={() => setHover(t.id)} onMouseLeave={() => setHover(null)}>
                  <ThreadSummary thread={t} />
                </button>
              )}
            </div>
          ))}
        </div>,
        document.body,
      )}

      {panelOpen && createPortal(
        <CommentsPanel
          threads={threads}
          anchored={anchors}
          data={data}
          api={api}
          onJump={jumpTo}
          onClose={onPanelClose}
        />,
        document.body,
      )}
    </>
  );
}

function ThreadSummary({ thread }: { thread: CommentThread }) {
  const first = thread.comments[0];
  const replies = thread.comments.length - 1;
  return (
    <>
      <span className="comment-summary__head">
        <Avatar username={first.author.username} name={first.author.name} size={20} />
        <span className="comment__name">{first.author.name}</span>
      </span>
      <span className="comment-summary__body">{first.body}</span>
      {(replies > 0 || first.reactions.length > 0) && (
        <span className="comment-summary__meta">
          {replies > 0 && <span>{replies} {replies === 1 ? 'reply' : 'replies'}</span>}
          {first.reactions.map(r => <span key={r.emoji}>{r.emoji} {r.count}</span>)}
        </span>
      )}
    </>
  );
}

/** Every thread on the note: open ones (and detached), resolved ones, and a whole-note comment box. */
function CommentsPanel({ threads, anchored, data, api, onJump, onClose }: {
  threads: CommentThread[];
  anchored: Map<number, Range>;
  data: NonNullable<Api['data']>;
  api: Api;
  onJump: (t: CommentThread) => void;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<'open' | 'resolved'>('open');
  const open = threads.filter(t => !t.resolved);
  const resolved = threads.filter(t => t.resolved);
  const list = tab === 'open' ? open : resolved;
  return (
    <aside className="comment-ui comment-panel" aria-label="Comments">
      <header className="comment-panel__head">
        <h2 className="comment-panel__title"><MessageSquareText size={17} aria-hidden="true" /> Comments</h2>
        <button type="button" className="comment-icon" aria-label="Close comments" onClick={onClose}><X size={17} /></button>
      </header>
      <div className="comment-panel__tabs" role="tablist">
        <button type="button" role="tab" aria-selected={tab === 'open'} onClick={() => setTab('open')}>Open · {open.length}</button>
        <button type="button" role="tab" aria-selected={tab === 'resolved'} onClick={() => setTab('resolved')}>Resolved · {resolved.length}</button>
      </div>
      <div className="comment-panel__body">
        {tab === 'open' && (
          <div className="comment-card comment-panel__new">
            <CommentComposer people={data.people} placeholder="Comment on the whole note" submitLabel="Comment" compact
              busy={api.create.isPending} onSubmit={(body) => api.create.mutateAsync({ body })} />
            <p className="comment-panel__tip">Or select text in the note to comment on it.</p>
          </div>
        )}
        {list.length === 0 && (
          <p className="comment-panel__empty">{tab === 'open' ? 'No open comments.' : 'Nothing resolved yet.'}</p>
        )}
        {list.map(t => {
          const detached = !t.resolved && !!t.quote && !anchored.has(t.id);
          return (
            <div key={t.id} className="comment-card">
              {t.quote && !detached && (
                <button type="button" className="comment-panel__jump" onClick={() => onJump(t)} disabled={t.resolved}
                  title={t.resolved ? undefined : 'Show in note'}>
                  <blockquote className="comment-thread__quote">{t.quote.exact}</blockquote>
                </button>
              )}
              <CommentThreadView thread={t} data={data} api={api} detached={detached} />
            </div>
          );
        })}
      </div>
    </aside>
  );
}

/** The header button: how many open threads, and the way into the panel. */
export function CommentsButton({ count, onClick, pressed, inToolbar = false }: {
  count: number; onClick: () => void; pressed: boolean;
  /** Drawn as one of the note's footer actions rather than a header pill. */
  inToolbar?: boolean;
}) {
  return (
    <button type="button" className={inToolbar ? `note-toolbar__btn comments-button--toolbar${pressed ? ' is-active' : ''}` : 'comments-button'}
      aria-pressed={pressed} onClick={onClick}
      aria-label={count ? `Comments (${count} open)` : 'Comments'} title="Comments">
      <MessageSquareText size={inToolbar ? 18 : 16} aria-hidden="true" />
      {count > 0 && <span className="comments-button__count">{count}</span>}
    </button>
  );
}
