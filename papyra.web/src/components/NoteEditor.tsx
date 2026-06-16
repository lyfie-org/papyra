import { useCallback, useRef, useState } from 'react';
import { MarkDownEditor, type ExtensiveEditorRef } from '@lyfie/luthor';
import '@lyfie/luthor/styles.css';
import type { Note } from '../types/note';
import { useAutoSave, type Draft } from '../hooks/useAutoSave';
import { useTheme } from '../hooks/useTheme';
import './NoteEditor.css';

const STATUS_LABEL = {
  idle: '',
  saving: 'Saving…',
  saved: 'Saved to local disk',
} as const;

// The editing canvas for a single note. Luthor's markdown preset owns the body
// (uncontrolled — content is read imperatively at save time); a Marcellus title
// input sits above it. Both feed the debounced auto-save.
export default function NoteEditor({ note }: { note: Note }) {
  const { theme } = useTheme();
  const editorRef = useRef<ExtensiveEditorRef | null>(null);
  const [title, setTitle] = useState(note.title);
  // Mirror the title in a ref so the debounced save reads the live value, not a
  // value captured in the closure of the render that scheduled it.
  const titleRef = useRef(note.title);

  // Read the live draft on demand: title from the ref, body from Luthor's ref.
  const getDraft = useCallback((): Draft => ({
    title: titleRef.current,
    body: editorRef.current?.getMarkdown() ?? note.body,
  }), [note.body]);

  const { status, bump } = useAutoSave(note, getDraft);

  // YAML `color` tints the canvas; fonts come from the design tokens.
  const style = note.color ? { background: note.color } : undefined;

  return (
    <section className="note-editor" style={style}>
      <header className="note-editor__bar">
        <input
          className="note-editor__title"
          value={title}
          placeholder="Untitled"
          aria-label="Note title"
          onChange={(e) => { titleRef.current = e.target.value; setTitle(e.target.value); bump(); }}
        />
        <span className="note-editor__status" role="status">
          {STATUS_LABEL[status]}
        </span>
      </header>

      {/* contenteditable input events bubble here → mark the draft dirty. */}
      <div className="note-editor__canvas" onInput={bump}>
        <MarkDownEditor
          key={note.id}
          initialTheme={theme}
          defaultContent={note.body}
          placeholder="Start writing…"
          onReady={(methods) => { editorRef.current = methods; }}
        />
      </div>
    </section>
  );
}
