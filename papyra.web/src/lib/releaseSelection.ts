import {
  $getSelection,
  $setSelection,
  HISTORY_MERGE_TAG,
  SKIP_DOM_SELECTION_TAG,
  type LexicalEditor,
} from 'lexical';

/**
 * Lexical keeps its selection after the body loses focus, and any later update
 * — a transform registering, an image settling, a remote change — writes that
 * selection back to the DOM, which focuses the body. Typing in the title then
 * jumped to the end of the note mid-word. When focus moves to a field outside
 * the canvas, the editor lets go of its selection; clicking back into the body
 * sets a fresh one as usual.
 *
 * `scope` is the surface the editor lives in (the note sheet); `canvas` matches
 * the editor's own area inside it, whose controls (toolbar, menus) still act on
 * the selection.
 */
export function releaseSelectionOnLeave(editor: LexicalEditor, scope: HTMLElement, canvas: string): () => void {
  const releaseFor = (target: Element | null) => {
    if (!target || !scope.contains(target) || target.closest(canvas)) return;
    const root = editor.getRootElement();
    if (!root || root.contains(target)) return;
    if (editor.getEditorState().read(() => $getSelection()) === null) return;
    editor.update(() => { $setSelection(null); }, { tag: [HISTORY_MERGE_TAG, SKIP_DOM_SELECTION_TAG], discrete: true });
  };
  const onFocusIn = (e: FocusEvent) => releaseFor(e.target as Element | null);
  // Already in a field (the editor mounted while the title had focus).
  releaseFor(document.activeElement);
  scope.addEventListener('focusin', onFocusIn);
  return () => scope.removeEventListener('focusin', onFocusIn);
}
