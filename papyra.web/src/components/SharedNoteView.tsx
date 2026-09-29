import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import {
  PapyraEditor, type PapyraEditorRef, type PapyraEditorAdapter,
} from '@lyfie/luthor/presets/papyra';
import '@lyfie/luthor/styles.css';
import { Check, Eye, Loader2, PencilLine } from 'lucide-react';
import { useResolvedTheme } from '../hooks/useTheme';
import { useInPlaceWikilinks } from '../hooks/useInPlaceWikilinks';
import { tintInkClass } from '../lib/noteColors';
import { hasBridgePlaceholder } from '../lib/bridgePlaceholder';
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
// `mediaUrl` maps an embedded ![[file]] to a share-scoped media endpoint so
// images load without the viewer needing access to the owner's vault.
export default function SharedNoteView({
  note, onSave, onRequestEdit, mediaUrl,
}: {
  note: SharedNote;
  onSave?: (body: string) => Promise<void>;
  onRequestEdit?: () => Promise<void>;
  mediaUrl: (filename: string) => string;
}) {
  const theme = useResolvedTheme();
  const editorRef = useRef<PapyraEditorRef | null>(null);
  const articleRef = useRef<HTMLElement | null>(null);
  const [status, setStatus] = useState<Status>('idle');
  const [requesting, setRequesting] = useState(false);

  // Minimal host seam: media resolves through the share endpoint; uploads and
  // note navigation are inert on a shared surface.
  const adapter = useMemo<PapyraEditorAdapter>(() => ({
    resolveMediaUrl: (filename) => mediaUrl(filename),
    uploadMedia: async () => { throw new Error('Uploads are disabled on shared notes.'); },
    openNote: () => {},
    searchNotes: async () => [],
  }), [mediaUrl]);
  // Inert here too — without this Lexical would open the `#` href in a new tab.
  useInPlaceWikilinks(articleRef, noop);

  const colored = !!note.color;
  const canEdit = note.access === 'edit' && !!onSave;
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

  async function requestEdit() {
    if (!onRequestEdit) return;
    setRequesting(true);
    try { await onRequestEdit(); } finally { setRequesting(false); }
  }

  return (
    <article ref={articleRef} className={`shared-note${colored ? ` shared-note--colored${tintInkClass(note.color, theme)}` : ''}`} style={style}>
      <header className="shared-note__bar">
        <h1 className="shared-note__title">{note.title.trim() || 'Untitled'}</h1>
        {canEdit ? (
          <span className="shared-note__status" role="status" aria-live="polite">
            {status === 'saving' && <><Loader2 size={13} className="shared-note__spin" aria-hidden="true" /> Saving…</>}
            {status === 'saved' && <><Check size={13} aria-hidden="true" /> Saved</>}
            {status === 'error' && 'Couldn’t save — retrying on your next edit'}
            {status === 'idle' && <><PencilLine size={13} aria-hidden="true" /> You can edit</>}
          </span>
        ) : (
          <span className="shared-note__badge"><Eye size={13} aria-hidden="true" /> View only</span>
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

      {!canEdit && onRequestEdit && (
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

      <PapyraEditor
        // Re-mounted when access changes, so an approval turns the page
        // editable in place.
        key={`${editorTheme}-${colored ? 'tint' : 'plain'}-${canEdit ? 'edit' : 'view'}`}
        initialTheme={editorTheme}
        colored={colored}
        readOnly={!canEdit}
        defaultEditorView="visual"
        defaultContent={note.body}
        adapter={adapter}
        onChange={onChange}
        onReady={(m) => {
          editorRef.current = m;
          m.setMarkdown(note.body);
          const read = m.getMarkdown();
          baseline.current = hasBridgePlaceholder(read) ? note.body : read;
        }}
      />
    </article>
  );
}
