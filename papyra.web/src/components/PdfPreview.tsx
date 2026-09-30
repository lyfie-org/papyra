import { useState } from 'react';
import { ChevronUp, ExternalLink, FileText } from 'lucide-react';
import { inlinePdfSupported, pdfViewUrl } from '../lib/pdfPreview';
import './PdfPreview.css';

// A PDF attachment read in place: the file card's "Preview" opens the
// browser's own PDF viewer in a frame under it (70% of the window, drag the
// corner for more), at the page the embed names (`![[report.pdf#page=3]]`).
// The frame loads from `…/media/view/…`, the one media route allowed inside Papyra's
// page. Where there is no inline viewer (iPhone/iPad Safari shows only a first
// page, some browsers download instead) or the file can't be reached, it offers
// the file in a new tab rather than an empty box.

type State = 'closed' | 'checking' | 'open' | 'failed';

export default function PdfPreview({ url, fragment, target }: { url: string; fragment: string; target: string }) {
  const [state, setState] = useState<State>('closed');
  const src = pdfViewUrl(url, fragment);
  const inline = inlinePdfSupported();

  // Ask before framing: a missing or no-longer-shared file would otherwise
  // fill the frame with an error page.
  const open = async () => {
    setState('checking');
    try {
      const res = await fetch(src.split('#')[0], { method: 'HEAD', credentials: 'same-origin' });
      setState(res.ok ? 'open' : 'failed');
    } catch {
      setState('failed');
    }
  };

  const newTab = (
    <a className="pdf-preview__button" href={src} target="_blank" rel="noopener noreferrer">
      <ExternalLink size={14} aria-hidden="true" /> Open in new tab
    </a>
  );

  // Keep the editor's selection and caret where they are: these are chrome,
  // not text.
  const keep = (e: React.MouseEvent) => e.preventDefault();

  return (
    <span className="pdf-preview" contentEditable={false} onMouseDown={keep}>
      <span className="pdf-preview__bar">
        {!inline ? newTab : state === 'open' ? (
          <>
            <button type="button" className="pdf-preview__button" aria-expanded="true" onClick={() => setState('closed')}>
              <ChevronUp size={14} aria-hidden="true" /> Hide preview
            </button>
            {newTab}
          </>
        ) : (
          <button
            type="button"
            className="pdf-preview__button"
            aria-expanded="false"
            disabled={state === 'checking'}
            onClick={() => { void open(); }}
          >
            <FileText size={14} aria-hidden="true" /> {state === 'checking' ? 'Opening…' : 'Preview PDF'}
          </button>
        )}
      </span>
      {state === 'failed' && (
        <span className="pdf-preview__failed" role="status">
          Couldn’t open this PDF here. {newTab}
        </span>
      )}
      {inline && state === 'open' && (
        <span className="pdf-preview__frame">
          <iframe src={src} title={`PDF: ${target}`} loading="lazy" />
        </span>
      )}
    </span>
  );
}
