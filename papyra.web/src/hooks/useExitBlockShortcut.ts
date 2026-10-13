import { useEffect } from 'react';
import {
  $createParagraphNode, $getSelection, $isElementNode, $isRangeSelection,
  type LexicalEditor, type LexicalNode,
} from 'lexical';

// Blocks that keep the caret inside on Enter: a code block takes every Enter as
// a new line, a quote, a list or a table a new line, item or row. Ctrl+Enter
// (Cmd+Enter on a Mac) leaves at once, to a fresh paragraph below the block,
// instead of pressing Enter on blank lines until it lets go.
const PLAIN = new Set(['paragraph', 'heading']);

/** The top-level block the caret is in, when it is one Ctrl+Enter leaves. */
export function $blockToExit(node: LexicalNode): LexicalNode | null {
  const top = node.getTopLevelElement();
  if (!top || !$isElementNode(top) || PLAIN.has(top.getType())) return null;
  return top;
}

/** Move the caret out of its block, below it. False when there is nothing to leave. */
export function $exitBlock(): boolean {
  const selection = $getSelection();
  if (!$isRangeSelection(selection)) return false;
  const block = $blockToExit(selection.focus.getNode());
  if (!block) return false;
  const next = block.getNextSibling();
  // Already followed by an empty paragraph: step into it rather than stacking
  // another blank line under the block.
  if (next && next.getType() === 'paragraph' && $isElementNode(next) && next.getChildrenSize() === 0) {
    next.selectStart();
    return true;
  }
  const paragraph = $createParagraphNode();
  block.insertAfter(paragraph);
  paragraph.select();
  return true;
}

// On the root, in the capture phase: luthor's own Enter handling for quotes,
// lists and code runs as a Lexical command and would otherwise take the key
// first (a new line in the quote) whatever the modifier.
export function useExitBlockShortcut(editor: LexicalEditor | null) {
  useEffect(() => {
    if (!editor) return;
    let detach: (() => void) | null = null;
    const removeRoot = editor.registerRootListener((root) => {
      detach?.();
      detach = null;
      if (!root) return;
      const onKeyDown = (event: KeyboardEvent) => {
        if (event.key !== 'Enter' || event.isComposing || !(event.ctrlKey || event.metaKey)
          || event.shiftKey || event.altKey || !editor.isEditable()) return;
        let exited = false;
        editor.update(() => { exited = $exitBlock(); }, { discrete: true });
        if (!exited) return;
        event.preventDefault();
        event.stopPropagation();
      };
      root.addEventListener('keydown', onKeyDown, true);
      detach = () => root.removeEventListener('keydown', onKeyDown, true);
    });
    return () => {
      removeRoot();
      detach?.();
    };
  }, [editor]);
}
