import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import {
  PapyraEditor, type PapyraEditorRef, type PapyraEditorAdapter,
} from '@lyfie/luthor/presets/papyra';
import '@lyfie/luthor/styles.css';
import { LexicalCollaboration } from '@lexical/react/LexicalCollaborationContext';
import { Check, Eye, Loader2, PencilLine, Pin } from 'lucide-react';
import { useResolvedTheme } from '../hooks/useTheme';
import { useInPlaceWikilinks } from '../hooks/useInPlaceWikilinks';
import { tintInkClass } from '../lib/noteColors';
import { hasBridgePlaceholder } from '../lib/bridgePlaceholder';
import { useCollabRoom } from '../hooks/useCollabRoom';
import NoteComments, { CommentsButton } from './comments/NoteComments';
import { useComments } from '../hooks/useComments';
import { useCollabCursorLabels } from '../hooks/useCollabCursorLabels';
import type { LexicalEditor } from 'lexical';
import CollabPresence from './CollabPresence';
import CollabJoining from './CollabJoining';
import { mediaMetaStore, mediaUrl, useMediaMetaReady } from '../lib/mediaMeta';
import { createMediaToolbarItems } from '../lib/mediaToolbar';
import { pauseOffscreenVideos } from '../lib/videoVisibility';
import { keepMediaToolbarsInView } from '../lib/mediaToolbarPlacement';
import { renderPdfExpansion } from '../lib/pdfPreview';
import { useToast } from '../lib/toastContext';
import './NoteToolbar.css';
import './SharedNoteView.css';

export interface SharedNote {
  title: string;
  body: string;
  color: string | null;
  access: 'view' | 'edit';
  /** Who shared it — present for user shares, absent on public links. */
  owner?: string | null;
  /** The viewer has asked for edit access and is waiting on the owner. */
  requestPending?: boolean;
  /** Public links: who shared it. */
  sharedBy?: { username: string; name: string; handle?: string } | null;
  /** Public links: times the link has been opened (this visit included), and its cap. */
  views?: number;
  maxViews?: number | null;
}

/** `Name (user@domain)` — the domain makes a public link's sharer unambiguous
 * across Papyra installations (usernames are only unique per instance). */
function sharerLabel(by: NonNullable<SharedNote['sharedBy']>): string {
  const handle = by.handle ?? `@${by.username}`;
  return by.name && by.name !== by.username ? `${by.name} (${handle})` : handle;
}

/** Quiet period after the last keystroke before an edit is written back. */
const AUTOSAVE_MS = 800;
const noop = () => {};

type Status = 'idle' | 'saving' | 'saved' | 'error';

// Renders a shared note (public link or incoming user share). An editor saves
// as they type, like the owner's own editor — no Save button to forget. A
// viewer sees a "Request edit access" button when `onRequestEdit` is given.
// `mediaBase` is the share-scoped media endpoint an embedded ![[file]] loads
// from (originals, thumbnails, metadata), so images load without the viewer
// needing access to the owner's vault.
//
// `collab`: a signed-in grantee's share — the note opens in its live room
// (everyone's carets, the room saves), viewers read-only but still seeing
// carets. Falls back to the save-as-you-type path above when the embedded
// collab engine is off. Public links never pass it.
export default function SharedNoteView({
  note, onSave, onSaveTitle, onRequestEdit, mediaBase, collab, pin, onClose,
}: {
  note: SharedNote;
  onSave?: (body: string) => Promise<void>;
  /** An editor renames the note (live or not); omitted, the title is read-only. */
  onSaveTitle?: (title: string) => Promise<void>;
  onRequestEdit?: () => Promise<void>;
  mediaBase: string;
  collab?: { shareId: number };
  /** The viewer's own pin for it (signed-in grantees). */
  pin?: { pinned: boolean; onToggle: () => void };
  /** Shown as a Close button at the foot (the modal). */
  onClose?: () => void;
}) {
  const theme = useResolvedTheme();
  const editorRef = useRef<PapyraEditorRef | null>(null);
  const articleRef = useRef<HTMLElement | null>(null);
  const [status, setStatus] = useState<Status>('idle');
  const [requesting, setRequesting] = useState(false);

  const cursorsRef = useRef<HTMLDivElement>(null);
  const room = useCollabRoom(collab ? { shareId: collab.shareId } : null, cursorsRef, note.access);
  const live = !!collab && room.status !== 'unavailable';
  const liveEdit = live && room.access === 'edit';
  const [lexical, setLexical] = useState<LexicalEditor | null>(null);
  const liveKey = live && room.collaboration ? String(room.generation) : null;
  useCollabCursorLabels(cursorsRef, liveKey);
  useEffect(() => {
    if (liveKey && lexical) lexical.setEditable(liveEdit && room.synced);
  }, [liveKey, lexical, liveEdit, room.synced]);

  // Comments: signed-in sharees only (a public link has no one to sign them).
  const comments = useComments(collab ? { shareId: collab.shareId } : null);
  const [commentsPanel, setCommentsPanel] = useState(false);
  const [openThreadId] = useState(() => Number(new URLSearchParams(window.location.search).get('comment')) || null);
  const openComments = useCallback(() => setCommentsPanel(true), []);
  const closeComments = useCallback(() => setCommentsPanel(false), []);

  // Minimal host seam: media resolves through the share endpoint; uploads and
  // note navigation are inert on a shared surface. Built once per share —
  // a new adapter would re-render every embed.
  const { toast } = useToast();
  // Attachments' sizes and thumbnails known before the editor draws them.
  const mediaReady = useMediaMetaReady(note.body, mediaBase);
  const adapter = useMemo<PapyraEditorAdapter>(() => {
    const meta = mediaMetaStore(mediaBase);
    return {
      resolveMediaUrl: (filename, options) => mediaUrl(mediaBase, filename, options, meta.get(filename)),
      getMediaMeta: (filename) => meta.get(filename),
      subscribeMediaMeta: (listener) => meta.subscribe(listener),
      renderFileExpansion: renderPdfExpansion,
      validateMedia: () => 'Attachments can’t be added to a shared note.',
      onUploadError: (error) => toast(error instanceof Error ? error.message : 'Couldn’t attach that file.'),
      uploadMedia: async () => { throw new Error('Attachments can’t be added to a shared note.'); },
      mediaToolbarItems: createMediaToolbarItems({ upload: () => Promise.reject(new Error('read-only')), readOnly: true }),
      openNote: () => {},
      searchNotes: async () => [],
    };
  }, [mediaBase, toast]);
  // Inert here too — without this Lexical would open the `#` href in a new tab.
  useInPlaceWikilinks(articleRef, noop);
  useEffect(() => (articleRef.current ? pauseOffscreenVideos(articleRef.current) : undefined), []);
  useEffect(() => (articleRef.current ? keepMediaToolbarsInView(articleRef.current) : undefined), []);

  const colored = !!note.color;
  const canEdit = !live && note.access === 'edit' && !!onSave;
  // Painted exactly like the owner's open note: `--note-tint` mixed by
  // --tint-strength (muted in dark mode), and a coloured note keeps a light
  // editor for dark ink — the NoteEditor convention.
  const style = note.color ? ({ '--note-tint': note.color } as CSSProperties) : undefined;
  const editorTheme = colored ? 'light' : theme;

  // What the server last holds. Starts as the editor's own serialization of the
  // loaded note (see onReady) so merely opening it never writes anything back.
  const baseline = useRef(note.body);
  const pending = useRef<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const saveRef = useRef(onSave);
  useEffect(() => { saveRef.current = onSave; }, [onSave]);

  const flush = useCallback(async () => {
    clearTimeout(timer.current);
    const body = pending.current;
    if (body == null || !saveRef.current) return;
    pending.current = null;
    setStatus('saving');
    try {
      await saveRef.current(body);
      baseline.current = body;
      setStatus('saved');
    } catch {
      // Keep it queued so the next keystroke (or closing) tries again.
      pending.current = pending.current ?? body;
      setStatus('error');
    }
  }, []);

  // Closing the modal mid-pause still lands the last words.
  useEffect(() => () => { void flush(); }, [flush]);

  const onChange = useCallback(({ markdown, source }: { markdown: string; source: 'user' | 'programmatic' | 'remote' }) => {
    if (!canEdit || source !== 'user') return;
    if (hasBridgePlaceholder(markdown) || markdown === baseline.current) return;
    pending.current = markdown;
    clearTimeout(timer.current);
    timer.current = setTimeout(() => { void flush(); }, AUTOSAVE_MS);
  }, [canEdit, flush]);

  // The title: anyone who may edit the text may rename the note. Saved on a
  // pause like the body; a rename from elsewhere shows unless one is being typed.
  const titleEditable = !!onSaveTitle && (canEdit || liveEdit);
  const [title, setTitle] = useState(note.title);
  const titleDirty = useRef(false);
  const titleTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const pendingTitle = useRef<string | null>(null);
  const saveTitleRef = useRef(onSaveTitle);
  useEffect(() => { saveTitleRef.current = onSaveTitle; }, [onSaveTitle]);
  useEffect(() => { if (!titleDirty.current) setTitle(note.title); }, [note.title]);
  const flushTitle = useCallback(async () => {
    clearTimeout(titleTimer.current);
    const next = pendingTitle.current;
    if (next == null || !saveTitleRef.current) return;
    pendingTitle.current = null;
    setStatus('saving');
    try {
      await saveTitleRef.current(next);
      if (pendingTitle.current == null) titleDirty.current = false;
      setStatus('saved');
    } catch {
      pendingTitle.current = pendingTitle.current ?? next;
      setStatus('error');
    }
  }, []);
  useEffect(() => () => { void flushTitle(); }, [flushTitle]);
  const onTitleChange = (value: string) => {
    setTitle(value);
    titleDirty.current = true;
    pendingTitle.current = value;
    clearTimeout(titleTimer.current);
    titleTimer.current = setTimeout(() => { void flushTitle(); }, AUTOSAVE_MS);
  };

  async function requestEdit() {
    if (!onRequestEdit) return;
    setRequesting(true);
    try { await onRequestEdit(); } finally { setRequesting(false); }
  }

  return (
    <article ref={articleRef} className={`shared-note${colored ? ` shared-note--colored${tintInkClass(note.color, theme)}` : ''}`} style={style}>
      <header className="shared-note__bar">
        {titleEditable ? (
          <input
            className="shared-note__title shared-note__title--input"
            value={title}
            placeholder="Untitled"
            aria-label="Note title"
            onChange={(e) => onTitleChange(e.target.value)}
            onBlur={() => { void flushTitle(); }}
          />
        ) : (
          <h1 className="shared-note__title">{note.title.trim() || 'Untitled'}</h1>
        )}
        {live ? (
          <>
            <CollabPresence
              provider={room.provider}
              status={room.status}
              cursorsRef={cursorsRef}
              selfUid={room.self?.uid ?? null}
              viewOnly={!liveEdit}
            />
            {room.status === 'live' && (liveEdit
              ? <span className="shared-note__status shared-note__status--live"><PencilLine size={13} aria-hidden="true" /><span className="shared-note__status-text"> Editing live</span></span>
              : <span className="shared-note__badge"><Eye size={13} aria-hidden="true" /> View only</span>)}
          </>
        ) : canEdit ? (
          <span className="shared-note__status" role="status" aria-live="polite">
            {status === 'saving' && <><Loader2 size={13} className="shared-note__spin" aria-hidden="true" /> Saving…</>}
            {status === 'saved' && <><Check size={13} aria-hidden="true" /> Saved</>}
            {status === 'error' && 'Couldn’t save — retrying on your next edit'}
            {status === 'idle' && <><PencilLine size={13} aria-hidden="true" /> You can edit</>}
          </span>
        ) : (
          <span className="shared-note__badge"><Eye size={13} aria-hidden="true" /> View only</span>
        )}
        {pin && (
          <button
            type="button"
            className={`note-toolbar__btn${pin.pinned ? ' is-active' : ''}`}
            aria-pressed={pin.pinned}
            aria-label={pin.pinned ? 'Unpin note' : 'Pin note'}
            title={pin.pinned ? 'Unpin from your notes' : 'Pin to your notes'}
            onClick={pin.onToggle}
          >
            <Pin size={18} fill={pin.pinned ? 'currentColor' : 'none'} />
          </button>
        )}
      </header>

      {(note.sharedBy || note.views != null) && (
        <p className="shared-note__meta">
          {note.sharedBy && (
            <span>Shared by <strong>{sharerLabel(note.sharedBy)}</strong></span>
          )}
          {note.views != null && (
            <span>
              {note.maxViews
                ? `View ${note.views} of ${note.maxViews}`
                : `Viewed ${note.views} time${note.views === 1 ? '' : 's'}`}
            </span>
          )}
        </p>
      )}

      {!canEdit && !liveEdit && onRequestEdit && room.status !== 'revoked' && room.status !== 'gone' && (
        <div className="shared-note__request">
          <p className="shared-note__request-text">
            {note.requestPending
              ? <>You asked {note.owner ? `@${note.owner}` : 'the owner'} for edit access. You’ll be able to edit as soon as they approve.</>
              : <>Want to make changes? Ask {note.owner ? `@${note.owner}` : 'the owner'} for edit access.</>}
          </p>
          <button
            type="button"
            className="shared-note__request-btn"
            disabled={note.requestPending || requesting}
            onClick={() => void requestEdit()}
          >
            {note.requestPending ? 'Requested' : requesting ? 'Sending…' : 'Request edit access'}
          </button>
        </div>
      )}

      {live && mediaReady && (
        <div className="shared-note__canvas">
          {room.status === 'revoked' || room.status === 'gone' ? (
            <p className="shared-note__gone" role="status">
              {room.status === 'revoked'
                ? 'This note is no longer shared with you.'
                : 'This note was deleted, trashed or locked by its owner.'}
            </p>
          ) : room.collaboration ? (
            <>
              {!room.synced && <CollabJoining body={note.body} />}
              <div className={room.synced ? undefined : 'collab-live--pending'} aria-hidden={room.synced ? undefined : true}>
              {/* Lexical ≥0.32 needs this provider above CollaborationPlugin;
                  luthor's PapyraEditor doesn't add it. */}
              <LexicalCollaboration>
                <PapyraEditor
                  // A new session (reconnect, access change) is a new Yjs doc.
                  key={`live-${room.generation}`}
                  initialTheme={editorTheme}
                  colored={colored}
                  readOnly={!liveEdit}
                  defaultEditorView="visual"
                  blockAnchors="off"
                  adapter={adapter}
                  collaboration={room.collaboration}
                  onReady={(m) => {
                    editorRef.current = m;
                    const editor = m.getLexicalEditor() ?? null;
                    setLexical(editor);
                    editor?.setEditable(liveEdit && room.synced);
                  }}
                />
              </LexicalCollaboration>
              </div>
              <div ref={cursorsRef} className="collab-cursors" aria-hidden="true" />
            </>
          ) : room.status === 'offline' ? (
            // Never reached the room: the last text we have, read-only.
            <PapyraEditor
              key="offline"
              initialTheme={editorTheme}
              colored={colored}
              readOnly
              defaultEditorView="visual"
              defaultContent={note.body}
              adapter={adapter}
              onReady={(m) => { m.setMarkdown(note.body); }}
            />
          ) : <CollabJoining body={note.body} />}
        </div>
      )}

      {!live && mediaReady && (
      <PapyraEditor
        // Re-mounted when access changes, so an approval turns the page
        // editable in place. Theme and tint apply without a remount.
        key={canEdit ? 'edit' : 'view'}
        initialTheme={editorTheme}
        colored={colored}
        readOnly={!canEdit}
        defaultEditorView="visual"
        defaultContent={note.body}
        adapter={adapter}
        onChange={onChange}
        onReady={(m) => {
          editorRef.current = m;
          setLexical(m.getLexicalEditor() ?? null);
          m.setMarkdown(note.body);
          const read = m.getMarkdown();
          baseline.current = hasBridgePlaceholder(read) ? note.body : read;
        }}
      />
      )}
      {((comments.data && collab) || onClose) && (
        <footer className="shared-note__footer">
          {comments.data && collab && (
            <CommentsButton count={comments.data.threads.filter(t => !t.resolved).length} pressed={commentsPanel}
              onClick={() => setCommentsPanel(o => !o)} />
          )}
          {onClose && <button type="button" className="note-close" onClick={onClose}>Close</button>}
        </footer>
      )}
      {collab && room.status !== 'revoked' && room.status !== 'gone' && (
        <NoteComments
          api={comments}
          rootEl={lexical?.getRootElement() ?? null}
          sheetRef={articleRef}
          focusMode={false}
          panelOpen={commentsPanel}
          onPanelOpen={openComments}
          onPanelClose={closeComments}
          openThreadId={openThreadId}
        />
      )}
    </article>
  );
}
