import { useEffect, type RefObject } from 'react';
import type { LexicalEditor } from 'lexical';
import { releaseSelectionOnLeave } from '../lib/releaseSelection';

/** The editor's own area: luthor's wrapper (toolbar, bubble, menus) and Papyra's canvas around it. */
const CANVAS = '.luthor-editor-wrapper, .note-editor__canvas';

/**
 * Keeps a note's body from taking focus away from the title or another field
 * while the person is typing there (see lib/releaseSelection).
 */
export function useReleaseSelectionOnLeave(editor: LexicalEditor | null, scopeRef: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const scope = scopeRef.current;
    if (!editor || !scope) return;
    return releaseSelectionOnLeave(editor, scope, CANVAS);
  }, [editor, scopeRef]);
}
