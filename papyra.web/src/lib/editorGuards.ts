import {
  $getSelection,
  $isElementNode,
  $isRangeSelection,
  $isTextNode,
  COMMAND_PRIORITY_CRITICAL,
  INSERT_PARAGRAPH_COMMAND,
  KEY_SPACE_COMMAND,
  $isParagraphNode,
  mergeRegister,
  type ElementNode,
  type LexicalEditor,
  type LexicalNode,
} from 'lexical';

// Luthor's BlockAnchorNode type. Matched by name rather than imported so Papyra
// does not reach into luthor-headless internals for one `instanceof`.
const ANCHOR_TYPE = 'blockAnchor';
const isAnchor = (n: LexicalNode | null | undefined) => !!n && n.getType() === ANCHOR_TYPE;

function blockOf(node: LexicalNode): ElementNode | null {
  let cur: LexicalNode | null = node;
  while (cur && !($isElementNode(cur) && !cur.isInline())) cur = cur.getParent();
  return cur;
}

/**
 * Keep Enter behaving normally on blocks that carry a hidden `^id` anchor.
 *
 * The anchor is an invisible inline node parked last in its block, and luthor
 * snaps the caret in front of it. So at the visual end of an anchored line the
 * caret is really *before* the anchor, and Enter splits the anchor off into the
 * new block. Two things then go wrong:
 *
 * - The new list item is not empty (it holds the anchor), so the second Enter
 *   that should leave the list just adds another item — the list never exits.
 * - The original block lost its anchor, so the next save stamps it a fresh id
 *   while the moved anchor follows whatever gets typed next (`^a ^b` pairs,
 *   renamed blocks, dangling `![[Note#^id]]` references).
 *
 * Runs ahead of the list/rich-text handlers and only adjusts the selection (or
 * drops an anchor from a block with no text left), then lets them do the split.
 */
function registerBlockAnchorEnterGuard(editor: LexicalEditor): () => void {
  return editor.registerCommand(
    INSERT_PARAGRAPH_COMMAND,
    () => {
      const selection = $getSelection();
      if (!$isRangeSelection(selection) || !selection.isCollapsed()) return false;

      const point = selection.anchor;
      const node = point.getNode();
      const block = blockOf(node);
      if (!block) return false;
      const children = block.getChildren();
      if (!children.some(isAnchor)) return false;

      // A block whose only content is its anchor reads as empty to the person
      // typing — make it empty for real, so Enter in an emptied list item exits
      // the list. An empty block is never stamped, so no id is lost that matters.
      // (The anchor's own text content is its ` ^id` markdown, so skip it.)
      const text = children.filter((c) => !isAnchor(c)).map((c) => c.getTextContent()).join('');
      if (text.trim().length === 0) {
        for (const c of children) if (isAnchor(c)) c.remove();
        block.select(0, 0);
        return false;
      }

      // Caret at the end of the text, with only the anchor after it: move it
      // past the anchor so the split leaves the anchor (and the id) behind.
      let after: LexicalNode[];
      if (point.type === 'element' && node === block) {
        after = children.slice(point.offset);
      } else if ($isTextNode(node) && node.getParent() === block && point.offset === node.getTextContentSize()) {
        after = node.getNextSiblings();
      } else {
        return false;
      }
      if (after.length > 0 && after.every(isAnchor)) {
        const end = block.getChildrenSize();
        block.select(end, end);
      }
      return false;
    },
    COMMAND_PRIORITY_CRITICAL,
  );
}

// Luthor's ordered-list shortcut: "1." / "a)" / "IV." alone in a paragraph.
const ORDERED_SHORTCUT = /^(?:\d+|[IVXLCDMivxlcdm]+|[A-Z]+)[.)]$/;

/**
 * Swallow the space that triggers luthor's ordered-list shortcut.
 *
 * Luthor turns "1." + Space into a numbered list, but its KEY_SPACE handler
 * does the conversion in a nested `editor.update()` — deferred until after the
 * handler returns, so it always reports "not handled" and never cancels the
 * key. The browser then types the space into the fresh item: every numbered
 * list started by typing began with a stray leading space (" Ramen", saved as
 * `1.  Ramen`). This runs first, mirrors luthor's match, and only cancels the
 * keystroke — luthor still does the conversion. Remove once luthor fixes it.
 */
function registerOrderedListSpaceGuard(editor: LexicalEditor): () => void {
  return editor.registerCommand(
    KEY_SPACE_COMMAND,
    (event: KeyboardEvent) => {
      const selection = $getSelection();
      if (!$isRangeSelection(selection) || !selection.isCollapsed()) return false;
      let cur: LexicalNode | null = selection.anchor.getNode();
      while (cur && !$isParagraphNode(cur)) {
        if (cur.getType() === 'list' || cur.getType() === 'listitem') return false;
        cur = cur.getParent();
      }
      if (cur && ORDERED_SHORTCUT.test(cur.getTextContent().trim())) event.preventDefault();
      return false;
    },
    COMMAND_PRIORITY_CRITICAL,
  );
}

/**
 * Papyra's fixes for luthor editing behaviour, registered on each editor mount.
 * Returns an unregister function.
 */
export function registerEditorGuards(editor: LexicalEditor): () => void {
  return mergeRegister(registerBlockAnchorEnterGuard(editor), registerOrderedListSpaceGuard(editor));
}
