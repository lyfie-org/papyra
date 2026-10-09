import { useSyncExternalStore } from 'react';
import { fileTypeOf } from './fileTypes';

// The one document open in the preview (a PDF in the browser's viewer, a text
// file as text). Opened from an attachment's card (double-click) or its
// toolbar's Preview; shown by <DocumentPreviewHost />, mounted once at the root.

export interface PreviewDocument {
  /** The attachment's URL (`/api/media/a.pdf`, or a share's). */
  url: string;
  /** The stored file name. */
  target: string;
  /** The embed's `#…` (a PDF page), or empty. */
  fragment: string;
  /** The name shown in the note (its alias, else the file name). */
  name: string;
}

let current: PreviewDocument | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export const documentPreview = {
  open(doc: PreviewDocument) { current = doc; emit(); },
  close() { if (current) { current = null; emit(); } },
  get: () => current,
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  },
};

export function useDocumentPreview(): PreviewDocument | null {
  return useSyncExternalStore(documentPreview.subscribe, documentPreview.get, documentPreview.get);
}

/** Open a document: in the preview when it can be read in place, else in a new tab. */
export function openDocument(doc: PreviewDocument) {
  if (fileTypeOf(doc.target).preview) documentPreview.open(doc);
  else window.open(doc.url, '_blank', 'noopener,noreferrer');
}
