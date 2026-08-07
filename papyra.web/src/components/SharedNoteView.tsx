import { useMemo, useRef, useState, type CSSProperties } from 'react';
import {
  PapyraEditor, type PapyraEditorRef, type PapyraEditorAdapter,
} from '@lyfie/luthor/presets/papyra';
import '@lyfie/luthor/styles.css';
import { useTheme } from '../hooks/useTheme';
import './SharedNoteView.css';

export interface SharedNote {
  title: string;
  body: string;
  color: string | null;
  access: 'view' | 'edit';
}

// Renders a shared note (public link or incoming user share). Read-only unless the
// grant is "edit", in which case a Save button flushes the body back via onSave.
// `mediaUrl` maps an embedded ![[file]] to a share-scoped media endpoint so images
// load without the viewer needing access to the owner's vault.
export default function SharedNoteView({
  note, onSave, mediaUrl,
}: { note: SharedNote; onSave?: (body: string) => Promise<void>; mediaUrl: (filename: string) => string }) {
  const { theme } = useTheme();
  const editorRef = useRef<PapyraEditorRef | null>(null);
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved'>('idle');

  // Minimal host seam: media resolves through the share endpoint; uploads and
  // note navigation are inert on a shared surface.
  const adapter = useMemo<PapyraEditorAdapter>(() => ({
    resolveMediaUrl: (filename) => mediaUrl(filename),
    uploadMedia: async () => { throw new Error('Uploads are disabled on shared notes.'); },
    openNote: () => {},
    searchNotes: async () => [],
  }), [mediaUrl]);

  const colored = !!note.color;
  const canEdit = note.access === 'edit' && !!onSave;
  const style = note.color ? ({ background: note.color } as CSSProperties) : undefined;

  async function save() {
    if (!onSave) return;
    const body = editorRef.current?.getMarkdown() ?? note.body;
    setStatus('saving');
    try { await onSave(body); setStatus('saved'); }
    catch { setStatus('idle'); }
  }

  return (
    <article className={`shared-note${colored ? ' shared-note--colored' : ''}`} style={style}>
      <header className="shared-note__bar">
        <h1 className="shared-note__title">{note.title.trim() || 'Untitled'}</h1>
        {canEdit && (
          <button type="button" className="shared-note__save" onClick={() => void save()}>
            {status === 'saving' ? 'Saving…' : status === 'saved' ? 'Saved' : 'Save'}
          </button>
        )}
        {!canEdit && <span className="shared-note__badge">Read only</span>}
      </header>
      <PapyraEditor
        key={`${theme}-${note.color ?? 'none'}`}
        initialTheme={theme}
        colored={colored}
        readOnly={!canEdit}
        defaultEditorView="visual"
        defaultContent={note.body}
        adapter={adapter}
        onReady={(m) => { editorRef.current = m; m.setMarkdown(note.body); }}
      />
    </article>
  );
}
