import { ArrowDown, ArrowUp, Download, Replace, ScanText } from 'lucide-react';
import { $getSelection, $isNodeSelection, type LexicalEditor, type LexicalNode } from 'lexical';
import type { MediaToolbarContext, MediaToolbarItem } from '@lyfie/luthor-headless';
import { pickFile } from './pickFile';
import type { PapyraMediaMeta } from './mediaMeta';

// Papyra's buttons on a selected attachment, after luthor's built-ins (align,
// caption, remove — its size presets, alt text and open-in-tab are hidden in
// MediaDropZone.css; the drag handles size a picture). They sit in the editor's own
// in-picture toolbar, so they come and go with the selection — no hover bar
// of our own racing it.

const ICON = { size: 16, strokeWidth: 2 } as const;

const ACCEPT: Record<string, string> = { image: 'image/*', video: 'video/*', audio: 'audio/*' };

interface Deps {
  /** Store a file; resolves to the name to reference. Rejects on failure (already reported). */
  upload: (file: File) => Promise<{ filename: string }>;
  /** Uploads are off (a shared note, a read-only view): no Replace. */
  readOnly?: boolean;
  /** The live editor, for moving the selected attachment. */
  getEditor?: () => LexicalEditor | null;
  /** A short confirmation (a toast). */
  notify?: (message: string) => void;
}

export function createMediaToolbarItems({ upload, readOnly, getEditor, notify }: Deps) {
  return (ctx: MediaToolbarContext): MediaToolbarItem[] => {
    const items: MediaToolbarItem[] = [];
    if (!readOnly) {
      items.push({
        id: 'papyra.replace',
        label: 'Replace',
        icon: <Replace {...ICON} />,
        onSelect: () => { void replace(ctx, upload); },
      });
    }
    const editor = getEditor?.();
    if (editor && !readOnly) {
      const [up, down] = editor.getEditorState().read(() => {
        const block = selectedBlock();
        return [!!block?.getPreviousSibling(), !!block?.getNextSibling()];
      });
      items.push(
        { id: 'papyra.move-up', label: 'Move up', icon: <ArrowUp {...ICON} />, disabled: !up, onSelect: () => move(editor, 'up') },
        { id: 'papyra.move-down', label: 'Move down', icon: <ArrowDown {...ICON} />, disabled: !down, onSelect: () => move(editor, 'down') },
      );
    }
    // The words read out of it in the background (the server's OCR of a
    // picture, a recording's transcript) — once there are some.
    const textKind = (ctx.meta as PapyraMediaMeta | null | undefined)?.text;
    if (textKind && !readOnly && typeof navigator !== 'undefined' && navigator.clipboard) {
      items.push({
        id: 'papyra.copy-text',
        label: textKind === 'transcript' ? 'Copy transcript' : 'Copy text in picture',
        icon: <ScanText {...ICON} />,
        onSelect: () => { void copyText(ctx.target, notify); },
      });
    }
    if (ctx.url) {
      items.push({
        id: 'papyra.download',
        label: 'Download',
        icon: <Download {...ICON} />,
        onSelect: () => download(ctx.url, ctx.target),
      });
    }
    return items;
  };
}

// The embed keeps its place, size, alignment, caption and alt text; only the
// file it points at changes. The old file stays until pruning finds it unused
// (history may still show it).
async function replace(ctx: MediaToolbarContext, upload: Deps['upload']) {
  const file = await pickFile(ACCEPT[ctx.kind]);
  if (!file) return;
  try {
    const { filename } = await upload(file);
    ctx.update({ target: filename });
  } catch {
    // Reported by the upload itself (a toast).
  }
}

// The toolbar only shows on a single selected attachment, so the node
// selection is the embed it belongs to. An inline embed moves with its line.
function selectedBlock(): LexicalNode | null {
  const selection = $getSelection();
  if (!$isNodeSelection(selection)) return null;
  const [node] = selection.getNodes();
  return node ? (node.getTopLevelElement() ?? node) : null;
}

// One step past its neighbour block; it stays selected (same node), so the
// toolbar follows it and the next press keeps going.
function move(editor: LexicalEditor, direction: 'up' | 'down') {
  editor.update(() => {
    const block = selectedBlock();
    if (!block) return;
    if (direction === 'up') block.getPreviousSibling()?.insertBefore(block);
    else block.getNextSibling()?.insertAfter(block);
  });
}

async function copyText(target: string, notify?: (message: string) => void) {
  try {
    const res = await fetch(`/api/media/${encodeURIComponent(target)}/text`, { credentials: 'same-origin' });
    if (!res.ok) throw new Error(String(res.status));
    const { kind, text } = (await res.json()) as { kind: string; text: string };
    await navigator.clipboard.writeText(text);
    const words = text.trim().split(/\s+/).filter(Boolean).length;
    notify?.(`${kind === 'transcript' ? 'Transcript' : 'Text'} copied (${words} word${words === 1 ? '' : 's'})`);
  } catch {
    notify?.('Couldn’t copy the text.');
  }
}

function download(url: string, name: string) {
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
}
