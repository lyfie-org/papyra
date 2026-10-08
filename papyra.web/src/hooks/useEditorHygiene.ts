import { useEffect, type RefObject } from 'react';
import type { LexicalEditor } from 'lexical';
import { registerMarkdownSafeFormats, releaseSelectionOnLeave } from '../lib/markdownSafeFormats';

/** The editor's own area: luthor's wrapper (toolbar, bubble, menus) and Papyra's canvas around it. */
const CANVAS = '.luthor-editor-wrapper, .note-editor__canvas';

/**
 * What every editable note canvas needs on top of luthor (see
 * lib/markdownSafeFormats): formatting that always survives a save and reopen,
 * and a body that never takes focus from the title or another field while the
 * person is typing there.
 */
export function useEditorHygiene(editor: LexicalEditor | null, scopeRef: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const scope = scopeRef.current;
    if (!editor || !scope) return;
    // The focus guard first: registering a transform runs an update over the
    // whole document, which must not be the one that moves focus.
    const release = releaseSelectionOnLeave(editor, scope, CANVAS);
    const unregister = registerMarkdownSafeFormats(editor);
    return () => { unregister(); release(); };
  }, [editor, scopeRef]);
}
