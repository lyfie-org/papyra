import {
  $createParagraphNode, $createTextNode, $getRoot, $getSelection, $isElementNode, $isRangeSelection, $isTextNode,
  type LexicalEditor, type LexicalNode,
} from 'lexical';
import { $createTransclusionNode, $createWikilinkNode } from '@lyfie/luthor-headless';
import { CHECKLIST_BLOCK } from './checklist';

/**
 * Put a `[[link]]` in the page at the caret (or at the end, when the caret isn't
 * in it), as the same wikilink node typing `[[` would make — so it is a link at
 * once, not text that only becomes one after a reload. A person's own action: the
 * one thing here that is allowed to move the caret.
 */
export function insertWikilink(editor: LexicalEditor, target: string): void {
  editor.update(() => {
    const selection = $getSelection();
    const into = $isRangeSelection(selection) ? selection : $getRoot().selectEnd();
    // A link butted against a word reads as one word: give it a space of its own.
    const anchor = into.anchor;
    const before = anchor.getNode();
    const prevChar = $isTextNode(before) && anchor.offset > 0 ? before.getTextContent()[anchor.offset - 1] : '';
    const nodes = [];
    if (prevChar && !/\s/.test(prevChar)) nodes.push($createTextNode(' '));
    nodes.push($createWikilinkNode(target), $createTextNode(' '));
    into.insertNodes(nodes);
  }, { onUpdate: () => editor.focus() });
}

/**
 * Put a to-do's live checklist in the page: `![[Title#^checklist]]` as a block of its
 * own after the paragraph the caret is in (or at the end), with a fresh paragraph
 * after it so there is somewhere to keep typing. The day's file stores the
 * reference only — never a copy of the items.
 */
export function insertTodoEmbed(editor: LexicalEditor, title: string): void {
  editor.update(() => {
    const selection = $getSelection();
    const top = $isRangeSelection(selection) ? selection.anchor.getNode().getTopLevelElement() : null;
    const embed = $createTransclusionNode(title, CHECKLIST_BLOCK);
    const after = $createParagraphNode();
    if (top) {
      // An empty paragraph the caret sits in becomes the embed; otherwise it goes below.
      if (top.getTextContentSize() === 0 && top.getType() === 'paragraph') { top.replace(embed); embed.insertAfter(after); }
      else { top.insertAfter(embed); embed.insertAfter(after); }
    } else {
      const root = $getRoot();
      root.append(embed, after);
    }
    after.selectStart();
  }, { onUpdate: () => editor.focus() });
}

const holds = (node: LexicalNode, needle: string): boolean =>
  JSON.stringify(node.exportJSON()).toLowerCase().includes(needle)
  || ($isElementNode(node) && node.getChildren().some((child) => holds(child, needle)));

/**
 * Put what a recording says under its player, as a line of its own. Written through the
 * editor like any edit (so it saves like one) and without touching the caret: the person
 * may be mid-sentence when the words arrive. False when the recording is no longer on the page.
 */
export function insertTranscript(editor: LexicalEditor, fileName: string, text: string): boolean {
  let placed = false;
  editor.update(() => {
    const needle = fileName.toLowerCase();
    const top = $getRoot().getChildren().find((node) => holds(node, needle));
    if (!top) return;
    const line = $createParagraphNode();
    line.append($createTextNode(`Transcript: ${text.trim()}`).toggleFormat('italic'));
    top.insertAfter(line);
    placed = true;
  }, { discrete: true });
  return placed;
}
