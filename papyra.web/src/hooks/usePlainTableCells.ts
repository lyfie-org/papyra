import { useEffect } from 'react';
import type { LexicalEditor } from 'lexical';
import { TableCellNode } from '@lexical/table';

/**
 * Keeps table cells on the note's own paper.
 *
 * A table pasted from Google Docs, Word or a web page brings each cell's
 * background with it — Docs paints every cell white — and Lexical keeps it as
 * an inline colour, so the pasted table sat as a white block on a tinted note
 * (or a glaring one in dark mode). A note has no cell colours: markdown can't
 * hold them, so they would vanish on the next open anyway. Drop them as they
 * arrive and let the table take the note's surface, borders and ink.
 */
export function usePlainTableCells(editor: LexicalEditor | null) {
  useEffect(() => {
    if (!editor || !editor.hasNodes([TableCellNode])) return;
    return editor.registerNodeTransform(TableCellNode, (cell) => {
      if (cell.getBackgroundColor() !== null) cell.setBackgroundColor(null);
    });
  }, [editor]);
}
