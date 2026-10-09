import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Download, ExternalLink, X } from 'lucide-react';
import { useDialogFocus } from '../hooks/useDialogFocus';
import { documentPreview, useDocumentPreview, type PreviewDocument } from '../lib/documentPreview';
import { fileTypeOf } from '../lib/fileTypes';
import { inlinePdfSupported, pdfViewUrl } from '../lib/pdfPreview';
import { FileIcon } from './FileCard';
import './DocumentPreview.css';

// A document read in place, over the page: a PDF in the browser's own viewer
// (framed from `…/media/view/…`, the one media route allowed inside Papyra, at
// the page the embed names), a text file as text. Where there is no inline
// viewer (iPhone/iPad Safari, a browser that downloads PDFs) or the file can't
// be reached, it says so and offers the file instead of an empty frame.

/** Text larger than this is cut short (the rest is a download away). */
const TEXT_LIMIT = 512 * 1024;

type Body =
  | { state: 'loading' }
  | { state: 'pdf'; src: string }
  | { state: 'text'; text: string; truncated: boolean }
  | { state: 'unavailable'; reason: string };

async function load(doc: PreviewDocument, signal: AbortSignal): Promise<Body> {
  const type = fileTypeOf(doc.target);
  if (type.preview === 'pdf') {
    if (!inlinePdfSupported()) return { state: 'unavailable', reason: 'This browser can’t show PDFs inside the page.' };
    const src = pdfViewUrl(doc.url, doc.fragment);
    // Ask before framing: a missing or no-longer-shared file would otherwise
    // fill the frame with an error page.
    const res = await fetch(src.split('#')[0], { method: 'HEAD', credentials: 'same-origin', signal });
    return res.ok ? { state: 'pdf', src } : { state: 'unavailable', reason: 'This file couldn’t be opened.' };
  }
  const res = await fetch(doc.url, { credentials: 'same-origin', signal });
  if (!res.ok) return { state: 'unavailable', reason: 'This file couldn’t be opened.' };
  const blob = await res.blob();
  const text = await blob.slice(0, TEXT_LIMIT).text();
  return { state: 'text', text, truncated: blob.size > TEXT_LIMIT };
}

function Preview({ doc }: { doc: PreviewDocument }) {
  const ref = useRef<HTMLDivElement | null>(null);
  useDialogFocus(ref);
  const [body, setBody] = useState<Body>({ state: 'loading' });
  const close = () => documentPreview.close();

  useEffect(() => {
    // Keyed by document (see the host), so it starts out loading.
    const controller = new AbortController();
    load(doc, controller.signal).then(setBody, (error: unknown) => {
      if (!controller.signal.aborted) setBody({ state: 'unavailable', reason: error instanceof Error && error.name !== 'TypeError' ? error.message : 'This file couldn’t be opened.' });
    });
    return () => controller.abort();
  }, [doc]);

  useEffect(() => {
    // Capture phase: the preview owns Escape while it is open (the note under
    // it would otherwise close too).
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopImmediatePropagation();
      documentPreview.close();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  const type = fileTypeOf(doc.target);
  // A PDF opens in the browser's viewer (the view route), never as a download.
  const openHref = type.preview === 'pdf' ? pdfViewUrl(doc.url, doc.fragment) : doc.url;

  return createPortal(
    <div
      className="doc-preview"
      onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    >
      <div ref={ref} className="doc-preview__box" role="dialog" aria-modal="true" aria-labelledby="doc-preview-title">
        <header className="doc-preview__bar">
          <FileIcon name={doc.target} />
          <div className="doc-preview__titles">
            <h2 className="doc-preview__title" id="doc-preview-title">{doc.name}</h2>
            <span className="doc-preview__type">{type.name}{doc.name !== doc.target ? ` · ${doc.target}` : ''}</span>
          </div>
          <a className="doc-preview__action" href={openHref} target="_blank" rel="noopener noreferrer" title="Open in new tab" aria-label="Open in new tab">
            <ExternalLink size={16} aria-hidden="true" />
          </a>
          <a className="doc-preview__action" href={doc.url} download={doc.target} title="Download" aria-label="Download">
            <Download size={16} aria-hidden="true" />
          </a>
          <button type="button" className="doc-preview__action" onClick={close} title="Close (Esc)" aria-label="Close preview">
            <X size={18} aria-hidden="true" />
          </button>
        </header>
        <div className="doc-preview__body" aria-busy={body.state === 'loading'}>
          {body.state === 'loading' && <div className="doc-preview__loading" role="status">Opening…</div>}
          {body.state === 'pdf' && <iframe className="doc-preview__frame" src={body.src} title={doc.name} />}
          {body.state === 'text' && (
            <>
              <pre className="doc-preview__text">{body.text}</pre>
              {body.truncated && <p className="doc-preview__note">Showing the first 512 KB — download it for the rest.</p>}
            </>
          )}
          {body.state === 'unavailable' && (
            <div className="doc-preview__unavailable" role="status">
              <p>{body.reason}</p>
              <a className="doc-preview__button" href={openHref} target="_blank" rel="noopener noreferrer">Open the file</a>
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** Mounted once, at the root: shows whichever document is open. */
export default function DocumentPreviewHost() {
  const doc = useDocumentPreview();
  return doc ? <Preview key={`${doc.url}#${doc.fragment}`} doc={doc} /> : null;
}
