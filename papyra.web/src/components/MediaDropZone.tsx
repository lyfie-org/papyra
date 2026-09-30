import { useEffect, useRef, useState, type RefObject } from 'react';
import { $createParagraphNode, $getNearestNodeFromDOMNode, $getRoot, $isDecoratorNode, type LexicalEditor } from 'lexical';
import { UploadCloud } from 'lucide-react';
import './MediaDropZone.css';

// Longest gap between `dragover`s while files are still over the sheet. The
// browser fires them continuously, even when the pointer rests; a drag
// cancelled with Esc, or one that leaves the window, sends no `drop` or
// `dragend` to the page — only silence.
const DRAG_IDLE_MS = 400;

/**
 * The open note as a drop target, around luthor's own upload pipeline:
 *
 * - Files dragged anywhere over the sheet — title, margins, an empty note —
 *   light it up with "Drop to attach". The overlay can't stick: it clears on
 *   drop, on `dragend`, on luthor's `luthor:media-drop`, and when dragovers stop.
 * - A drop the editor body didn't take is handed to it at the nearest edge, so
 *   luthor places and uploads it like any other drop.
 * - A click below an attachment that ends the note opens a line to type on.
 *   Nothing is added until then: opening a note never changes it.
 */
export default function MediaDropZone({ editor, sheetRef }: {
  editor: LexicalEditor | null;
  sheetRef: RefObject<HTMLElement | null>;
}) {
  const [dragging, setDragging] = useState(false);
  const idle = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    const sheet = sheetRef.current;
    if (!sheet || !editor) return;
    const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes('Files');
    const stop = () => { clearTimeout(idle.current); setDragging(false); };

    const onOver = (e: DragEvent) => {
      if (!hasFiles(e) || !editor.isEditable()) return;
      e.preventDefault(); // allow the drop (and keep the browser from opening the file)
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
      setDragging(true);
      clearTimeout(idle.current);
      idle.current = setTimeout(stop, DRAG_IDLE_MS);
    };
    const onLeave = (e: DragEvent) => {
      // Left the sheet itself (not just moved between its children).
      if (!e.relatedTarget || !sheet.contains(e.relatedTarget as Node)) stop();
    };
    const onDrop = (e: DragEvent) => {
      stop();
      if (!hasFiles(e) || e.defaultPrevented || !editor.isEditable()) return;
      const root = editor.getRootElement();
      if (!root || root.contains(e.target as Node)) return;
      e.preventDefault();
      // Above the body (the title) → before its first block; beside or below
      // it → after its last. Aimed at the block itself: luthor places a drop
      // by the block under the point.
      const r = root.getBoundingClientRect();
      const above = e.clientY < r.top;
      const edge = (above ? root.firstElementChild : root.lastElementChild)?.getBoundingClientRect();
      editor.update(() => { if (above) $getRoot().selectStart(); else $getRoot().selectEnd(); });
      root.dispatchEvent(new DragEvent('drop', {
        bubbles: true,
        cancelable: true,
        dataTransfer: e.dataTransfer,
        clientX: edge ? edge.left + Math.min(8, edge.width / 2) : r.left + 1,
        clientY: edge ? (above ? edge.top + 1 : edge.bottom - 1) : (above ? r.top + 1 : r.bottom - 1),
      }));
    };

    sheet.addEventListener('dragover', onOver);
    sheet.addEventListener('dragleave', onLeave);
    sheet.addEventListener('drop', onDrop);
    sheet.addEventListener('luthor:media-drop', stop);
    window.addEventListener('dragend', stop, true);
    window.addEventListener('drop', stop, true);
    return () => {
      sheet.removeEventListener('dragover', onOver);
      sheet.removeEventListener('dragleave', onLeave);
      sheet.removeEventListener('drop', onDrop);
      sheet.removeEventListener('luthor:media-drop', stop);
      window.removeEventListener('dragend', stop, true);
      window.removeEventListener('drop', stop, true);
      stop();
    };
  }, [sheetRef, editor]);

  // Click below a trailing attachment → a paragraph to type in.
  useEffect(() => {
    const root = editor?.getRootElement();
    if (!root || !editor) return;
    const onDown = (e: MouseEvent) => {
      if (e.button !== 0 || e.target !== root || !editor.isEditable()) return;
      const last = root.lastElementChild;
      if (!last || e.clientY <= last.getBoundingClientRect().bottom) return;
      const endsWithEmbed = editor.read(() => {
        const node = $getNearestNodeFromDOMNode(last);
        return !!node && $isDecoratorNode(node) && $getRoot().getLastChild()?.is(node) === true;
      });
      if (!endsWithEmbed) return;
      e.preventDefault();
      editor.update(() => {
        const p = $createParagraphNode();
        $getRoot().append(p);
        p.select();
      });
      root.focus({ preventScroll: true });
    };
    root.addEventListener('mousedown', onDown);
    return () => root.removeEventListener('mousedown', onDown);
  }, [editor]);

  if (!dragging) return null;
  return (
    <div className="media-drop" aria-hidden="true">
      <div className="media-drop__card">
        <UploadCloud size={30} />
        <strong>Drop to attach</strong>
        <span>Images, GIFs, video, audio and documents</span>
      </div>
    </div>
  );
}
