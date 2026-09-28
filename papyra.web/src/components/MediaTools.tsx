import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import {
  $createParagraphNode, $createTextNode, $getNearestNodeFromDOMNode, $getNodeByKey, $getRoot, $isDecoratorNode,
  HISTORY_MERGE_TAG, type LexicalEditor, type LexicalNode,
} from 'lexical';
import { Captions, Download, GripVertical, ImagePlus, Trash2, UploadCloud } from 'lucide-react';
import './MediaTools.css';

type Upload = (file: File) => Promise<{ filename: string }>;

/** The embed node's stored reference (`![[target]]`). */
function targetOf(node: LexicalNode): string | null {
  const t = (node as unknown as { __target?: unknown }).__target;
  return typeof t === 'string' ? t : null;
}

/**
 * Attachments in the open note, made workable:
 *
 * - Hover (or tap) a picture, video or file to get its tools: replace it,
 *   add a caption, download it, remove it.
 * - Drag files anywhere over the note and the whole sheet says "Drop to
 *   attach" — including over an empty note, where there was no body to aim at.
 * - A note can always be typed below its last attachment: an embed is never
 *   left as the final block (there was nowhere for the caret to go).
 *
 * Works on the editor through Lexical, outside luthor, so it needs nothing
 * from the preset beyond the embeds it already renders.
 */
export default function MediaTools({ editor, sheetRef, upload, onError }: {
  editor: LexicalEditor | null;
  sheetRef: RefObject<HTMLElement | null>;
  upload: Upload;
  onError: (message: string) => void;
}) {
  const [hovered, setHovered] = useState<{ el: HTMLElement; rect: DOMRect } | null>(null);
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const replaceInput = useRef<HTMLInputElement | null>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const depth = useRef(0);
  // Reordering: the node being carried, and where it would land.
  const carrying = useRef<string | null>(null);
  const [indicator, setIndicator] = useState<{ top: number; left: number; width: number } | null>(null);

  // ── Always room to type after the last attachment ─────────────────────────
  useEffect(() => {
    if (!editor) return;
    const ensureTrailingParagraph = () => {
      const needs = editor.getEditorState().read(() => {
        const last = $getRoot().getLastChild();
        return last !== null && $isDecoratorNode(last);
      });
      if (needs && editor.isEditable()) {
        editor.update(() => { $getRoot().append($createParagraphNode()); }, { tag: HISTORY_MERGE_TAG });
      }
    };
    ensureTrailingParagraph();
    return editor.registerUpdateListener(ensureTrailingParagraph);
  }, [editor]);

  // ── Hover toolbar ────────────────────────────────────────────────────────────
  useEffect(() => {
    const root = editor?.getRootElement();
    if (!root) return;
    const onOver = (e: MouseEvent) => {
      const shell = (e.target as Element).closest?.('.luthor-file-embed-shell') as HTMLElement | null;
      if (!shell || !root.contains(shell)) return;
      clearTimeout(hideTimer.current);
      setHovered({ el: shell, rect: shell.getBoundingClientRect() });
    };
    const onOut = (e: MouseEvent) => {
      if (!(e.target as Element).closest?.('.luthor-file-embed-shell')) return;
      hideTimer.current = setTimeout(() => setHovered(null), 250);
    };
    const onMove = () => setHovered((h) => (h ? { el: h.el, rect: h.el.getBoundingClientRect() } : h));
    root.addEventListener('mouseover', onOver);
    root.addEventListener('mouseout', onOut);
    window.addEventListener('scroll', onMove, true);
    window.addEventListener('resize', onMove);
    return () => {
      root.removeEventListener('mouseover', onOver);
      root.removeEventListener('mouseout', onOut);
      window.removeEventListener('scroll', onMove, true);
      window.removeEventListener('resize', onMove);
      clearTimeout(hideTimer.current);
    };
  }, [editor]);

  const withNode = useCallback((fn: (node: LexicalNode) => void) => {
    const el = hovered?.el;
    if (!editor || !el) return;
    editor.update(() => {
      const node = $getNearestNodeFromDOMNode(el);
      if (node && $isDecoratorNode(node)) fn(node);
    });
  }, [editor, hovered]);

  const remove = () => {
    withNode((node) => {
      const next = node.getNextSibling() ?? node.getPreviousSibling();
      node.remove();
      next?.selectEnd?.();
    });
    setHovered(null);
  };

  const caption = () => {
    withNode((node) => {
      const after = node.getNextSibling();
      // Already captioned (an italic line right under it): just go there.
      const el = after ? editor!.getElementByKey(after.getKey()) : null;
      if (after && el?.querySelector(':scope > .luthor-text-italic:only-child')) { after.selectEnd(); return; }
      const p = $createParagraphNode();
      const text = $createTextNode('Caption');
      text.toggleFormat('italic');
      p.append(text);
      node.insertAfter(p);
      text.select(0, text.getTextContentSize());
    });
    setHovered(null);
    editor?.focus();
  };

  const replace = async (file: File) => {
    const el = hovered?.el;
    if (!editor || !el) return;
    setBusy(true);
    try {
      const { filename } = await upload(file);
      editor.update(() => {
        const node = $getNearestNodeFromDOMNode(el);
        if (!node || !$isDecoratorNode(node) || targetOf(node) === null) return;
        // The embed keeps its place; only what it points at changes.
        (node.getWritable() as unknown as { __target: string }).__target = filename;
      });
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Couldn’t upload that file.');
    } finally {
      setBusy(false);
      setHovered(null);
    }
  };

  const download = () => {
    const target = hovered ? editor?.read(() => {
      const node = $getNearestNodeFromDOMNode(hovered.el);
      return node ? targetOf(node) : null;
    }) : null;
    if (!target) return;
    const a = document.createElement('a');
    a.href = `/api/media/${encodeURIComponent(target)}`;
    a.download = target;
    a.click();
  };

  // ── Reorder: drag an attachment by its grip to another spot ────────────────
  const BLOCK_TYPE = 'application/x-papyra-block';
  useEffect(() => {
    const root = editor?.getRootElement();
    if (!root || !editor) return;
    // The top-level block under the pointer, and whether to land above or below it.
    const slot = (e: DragEvent) => {
      let el = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null;
      while (el && el.parentElement !== root) el = el.parentElement;
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { el, before: e.clientY < r.top + r.height / 2, rect: r };
    };
    const onOver = (e: DragEvent) => {
      if (!carrying.current || !Array.from(e.dataTransfer?.types ?? []).includes(BLOCK_TYPE)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
      const s = slot(e);
      if (s) setIndicator({ top: s.before ? s.rect.top - 3 : s.rect.bottom + 1, left: s.rect.left, width: s.rect.width });
    };
    const onDrop = (e: DragEvent) => {
      const key = carrying.current;
      if (!key || !Array.from(e.dataTransfer?.types ?? []).includes(BLOCK_TYPE)) return;
      e.preventDefault();
      e.stopPropagation();
      const s = slot(e);
      setIndicator(null);
      carrying.current = null;
      if (!s) return;
      editor.update(() => {
        const node = $getNodeByKey(key);
        const target = $getNearestNodeFromDOMNode(s.el);
        if (!node || !target || target.is(node)) return;
        const top = target.getTopLevelElement() ?? target;
        if (top.is(node)) return;
        // A caption travels with its picture.
        const next = node.getNextSibling();
        const nextEl = next ? editor.getElementByKey(next.getKey()) : null;
        const caption = next && nextEl?.querySelector(':scope > .luthor-text-italic:only-child') ? next : null;
        if (caption && top.is(caption)) return;
        if (s.before) top.insertBefore(node); else top.insertAfter(node);
        if (caption) node.insertAfter(caption);
      });
    };
    const onEnd = () => { carrying.current = null; setIndicator(null); };
    root.addEventListener('dragover', onOver);
    root.addEventListener('drop', onDrop, true);
    window.addEventListener('dragend', onEnd);
    return () => {
      root.removeEventListener('dragover', onOver);
      root.removeEventListener('drop', onDrop, true);
      window.removeEventListener('dragend', onEnd);
    };
  }, [editor]);

  const startCarry = (e: React.DragEvent) => {
    const el = hovered?.el;
    if (!editor || !el) return;
    const key = editor.read(() => $getNearestNodeFromDOMNode(el)?.getKey() ?? null);
    if (!key) return;
    carrying.current = key;
    e.dataTransfer.setData(BLOCK_TYPE, key);
    e.dataTransfer.effectAllowed = 'move';
    const img = el.querySelector('img, video');
    if (img) e.dataTransfer.setDragImage(img, 24, 24);
  };

  // ── Drop anywhere on the sheet ──────────────────────────────────────────────
  useEffect(() => {
    const sheet = sheetRef.current;
    if (!sheet || !editor) return;
    // Files only — an attachment being reordered is not an upload.
    const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes('Files') && !carrying.current;

    const onEnter = (e: DragEvent) => {
      if (!hasFiles(e) || !editor.isEditable()) return;
      depth.current++;
      setDragging(true);
    };
    const onLeave = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth.current = Math.max(0, depth.current - 1);
      if (depth.current === 0) setDragging(false);
    };
    const onOver = (e: DragEvent) => {
      if (hasFiles(e) && editor.isEditable()) e.preventDefault(); // allow the drop
    };
    // A drop the editor body didn't take (the title, the margins, an empty
    // note's blank sheet): hand it to the body at its end, so luthor uploads
    // and places it exactly as if it had been dropped there.
    const onDrop = (e: DragEvent) => {
      depth.current = 0;
      setDragging(false);
      if (!hasFiles(e) || e.defaultPrevented || !editor.isEditable()) return;
      const root = editor.getRootElement();
      if (!root || root.contains(e.target as Node)) return;
      e.preventDefault();
      editor.update(() => { $getRoot().selectEnd(); });
      const r = root.getBoundingClientRect();
      const relay = new DragEvent('drop', {
        bubbles: true, cancelable: true, dataTransfer: e.dataTransfer,
        clientX: r.left + 24, clientY: r.bottom - 8,
      });
      root.dispatchEvent(relay);
    };
    const onEnd = () => { depth.current = 0; setDragging(false); };

    sheet.addEventListener('dragenter', onEnter);
    sheet.addEventListener('dragleave', onLeave);
    sheet.addEventListener('dragover', onOver);
    sheet.addEventListener('drop', onDrop);
    window.addEventListener('dragend', onEnd);
    window.addEventListener('drop', onEnd);
    return () => {
      sheet.removeEventListener('dragenter', onEnter);
      sheet.removeEventListener('dragleave', onLeave);
      sheet.removeEventListener('dragover', onOver);
      sheet.removeEventListener('drop', onDrop);
      window.removeEventListener('dragend', onEnd);
      window.removeEventListener('drop', onEnd);
    };
  }, [sheetRef, editor]);

  const editable = editor?.isEditable() ?? false;

  return (
    <>
      {dragging && (
        <div className="media-drop" aria-hidden="true">
          <div className="media-drop__card">
            <UploadCloud size={30} />
            <strong>Drop to attach</strong>
            <span>Images, GIFs, video, audio and documents</span>
          </div>
        </div>
      )}

      {indicator && createPortal(
        <div className="media-drop-line" style={{ top: indicator.top, left: indicator.left, width: indicator.width }} />,
        document.body,
      )}

      {hovered && editable && createPortal(
        <div
          className="media-tools"
          role="toolbar"
          aria-label="Attachment"
          style={{ top: Math.max(8, hovered.rect.top + 8), left: hovered.rect.right - 8 }}
          onMouseEnter={() => clearTimeout(hideTimer.current)}
          onMouseLeave={() => { hideTimer.current = setTimeout(() => setHovered(null), 250); }}
          onMouseDown={(e) => e.preventDefault()} // keep the editor's focus
        >
          <span
            className="media-tools__btn media-tools__btn--icon media-tools__grip"
            draggable
            onDragStart={startCarry}
            title="Drag to move"
            aria-label="Drag to move"
            role="button"
          >
            <GripVertical size={15} />
          </span>
          <button type="button" className="media-tools__btn" disabled={busy} onClick={() => replaceInput.current?.click()} title="Replace">
            <ImagePlus size={15} /> <span>{busy ? 'Uploading…' : 'Replace'}</span>
          </button>
          <button type="button" className="media-tools__btn" onClick={caption} title="Add a caption">
            <Captions size={15} /> <span>Caption</span>
          </button>
          <button type="button" className="media-tools__btn media-tools__btn--icon" onClick={download} title="Download" aria-label="Download">
            <Download size={15} />
          </button>
          <button type="button" className="media-tools__btn media-tools__btn--icon media-tools__btn--danger" onClick={remove} title="Remove" aria-label="Remove">
            <Trash2 size={15} />
          </button>
          <input
            ref={replaceInput}
            type="file"
            hidden
            onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void replace(f); }}
          />
        </div>,
        document.body,
      )}
    </>
  );
}
