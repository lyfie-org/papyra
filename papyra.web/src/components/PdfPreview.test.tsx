// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { inlinePdfSupported, pdfViewUrl, renderPdfExpansion } from '../lib/pdfPreview';

// A PDF card previews in place through the one framable media route; where
// the browser can't show it inline, or the file can't be reached, it offers a
// new tab instead of an empty frame.

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const ctx = (over: Record<string, unknown> = {}) => ({
  target: 'report.pdf', fragment: '', url: '/api/media/report.pdf', kind: 'pdf', meta: undefined, ...over,
});

describe('pdfViewUrl', () => {
  it('puts the view route before the file name, and keeps only a page fragment', () => {
    expect(pdfViewUrl('/api/media/report.pdf', '')).toBe('/api/media/view/report.pdf');
    expect(pdfViewUrl('/api/media/report.pdf', 'page=3')).toBe('/api/media/view/report.pdf#page=3');
    expect(pdfViewUrl('/api/shared/tok/media/a%20b.pdf?x=1', 'zoom=2&page=12')).toBe('/api/shared/tok/media/view/a%20b.pdf#page=12');
    expect(pdfViewUrl('/api/shares/incoming/4/media/a.pdf', 'page=javascript:1')).toBe('/api/shares/incoming/4/media/view/a.pdf');
  });
});

describe('inlinePdfSupported', () => {
  const nav = (over: Partial<Navigator> & { pdfViewerEnabled?: boolean }) =>
    ({ userAgent: 'Mozilla/5.0 (Windows NT 10.0) Chrome/140', platform: 'Win32', maxTouchPoints: 0, pdfViewerEnabled: true, ...over }) as Navigator;
  it('is on for desktop browsers with a viewer', () => expect(inlinePdfSupported(nav({}))).toBe(true));
  it('is off without a viewer', () => expect(inlinePdfSupported(nav({ pdfViewerEnabled: false }))).toBe(false));
  it('is off on iPhone and iPad (a framed PDF is a still of page 1 there)', () => {
    expect(inlinePdfSupported(nav({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)' }))).toBe(false);
    expect(inlinePdfSupported(nav({ platform: 'MacIntel', maxTouchPoints: 5 }))).toBe(false);
  });
});

describe('renderPdfExpansion', () => {
  it('adds nothing to other files', () => {
    expect(renderPdfExpansion(ctx({ target: 'notes.docx', kind: 'file', url: '/api/media/notes.docx' }))).toBeNull();
  });

  it('checks the file, then frames it at the page', async () => {
    const fetcher = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetcher);
    render(<>{renderPdfExpansion(ctx({ fragment: 'page=3' }))}</>);
    const preview = screen.getByRole('button', { name: 'Preview PDF' });
    expect(preview.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(preview);
    const frame = await screen.findByTitle('PDF: report.pdf');
    expect(frame.getAttribute('src')).toBe('/api/media/view/report.pdf#page=3');
    expect(fetcher).toHaveBeenCalledWith('/api/media/view/report.pdf', expect.objectContaining({ method: 'HEAD' }));
    expect(screen.getByRole('link', { name: /Open in new tab/ }).getAttribute('href')).toBe('/api/media/view/report.pdf#page=3');

    fireEvent.click(screen.getByRole('button', { name: /Hide preview/ }));
    expect(screen.queryByTitle('PDF: report.pdf')).toBeNull();
  });

  it('offers a new tab instead of framing an error page', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 404 })));
    render(<>{renderPdfExpansion(ctx())}</>);
    fireEvent.click(screen.getByRole('button', { name: 'Preview PDF' }));
    await waitFor(() => expect(screen.getByRole('status').textContent).toMatch(/Couldn’t open this PDF here/));
    expect(document.querySelector('iframe')).toBeNull();
  });

  it('keeps the editor\'s caret: pressing its buttons is not a click into the text', () => {
    render(<>{renderPdfExpansion(ctx())}</>);
    const down = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    screen.getByRole('button', { name: 'Preview PDF' }).dispatchEvent(down);
    expect(down.defaultPrevented).toBe(true);
  });
});
