import type { ReactNode } from 'react';
import type { FileExpansionContext } from '@lyfie/luthor-headless';
import PdfPreview from '../components/PdfPreview';

/** Browsers whose framed PDF is a still of page 1, or no viewer at all. */
export function inlinePdfSupported(nav: Navigator = navigator): boolean {
  const ios = /iPad|iPhone|iPod/.test(nav.userAgent) || (nav.platform === 'MacIntel' && nav.maxTouchPoints > 1);
  const viewer = (nav as Navigator & { pdfViewerEnabled?: boolean }).pdfViewerEnabled;
  return !ios && viewer !== false;
}

/**
 * `/api/media/a.pdf` + `page=3` → `/api/media/view/a.pdf#page=3` (share
 * prefixes likewise). The file name stays last so the viewer titles and saves
 * the PDF by its own name.
 */
export function pdfViewUrl(url: string, fragment: string): string {
  const path = url.split(/[?#]/)[0];
  const cut = path.lastIndexOf('/');
  const page = /(?:^|&)page=(\d{1,5})(?:&|$)/.exec(fragment)?.[1];
  return `${path.slice(0, cut)}/view${path.slice(cut)}${page ? `#page=${page}` : ''}`;
}

/** The adapter's `renderFileExpansion`: PDFs get a preview, other files nothing. */
export function renderPdfExpansion(ctx: FileExpansionContext): ReactNode {
  const isPdf = ctx.kind === 'pdf' || /\.pdf$/i.test(ctx.target);
  if (!isPdf || !ctx.url) return null;
  return <PdfPreview url={ctx.url} fragment={ctx.fragment} target={ctx.target} />;
}
