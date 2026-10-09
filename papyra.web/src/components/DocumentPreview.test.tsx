// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { inlinePdfSupported, pdfViewUrl } from '../lib/pdfPreview';
import { documentPreview } from '../lib/documentPreview';
import { baseName, fileTypeOf } from '../lib/fileTypes';
import DocumentPreviewHost from './DocumentPreview';
import FileCard from './FileCard';

// Documents in a note: a desktop-style icon and name; opened (PDF in the
// browser's viewer, text as text) in a preview over the page, through the one
// framable media route — and never an empty frame when that can't work.

afterEach(() => { act(() => documentPreview.close()); cleanup(); vi.unstubAllGlobals(); });

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

describe('fileTypeOf', () => {
  it.each([
    ['report.pdf', 'pdf', 'PDF', 'pdf'],
    ['Letter.DOCX', 'doc', 'DOCX', null],
    ['budget.xlsx', 'sheet', 'XLSX', null],
    ['data.csv', 'sheet', 'CSV', 'text'],
    ['deck.pptx', 'slides', 'PPTX', null],
    ['photos.zip', 'archive', 'ZIP', null],
    ['readme.md', 'text', 'MD', 'text'],
    ['app.ts', 'code', 'TS', 'text'],
    ['book.epub', 'book', 'EPUB', null],
    ['mystery.xyz', 'file', 'XYZ', null],
    ['no-extension', 'file', 'FILE', null],
  ])('%s → %s', (name, family, label, preview) => {
    const type = fileTypeOf(name);
    expect(type.family).toBe(family);
    expect(type.label).toBe(label);
    expect(type.preview).toBe(preview);
  });

  it('drops the extension for a base name', () => {
    expect(baseName('q3-report.final.pdf')).toBe('q3-report.final');
  });
});

const card = (over: Record<string, unknown> = {}) => ({
  target: 'q3.pdf', fragment: '', url: '/api/media/q3.pdf', kind: 'pdf', meta: { size: 1_300_000 },
  label: 'q3.pdf', interactive: true, selected: false, ...over,
});

describe('FileCard', () => {
  it('shows the icon and the name — and the type and size only as a tooltip', () => {
    render(<FileCard {...card({ label: 'Q3 report' })} />);
    expect(screen.getByText('Q3 report')).toBeTruthy();
    expect(screen.getByText('PDF')).toBeTruthy(); // the icon's band
    const el = screen.getByText('Q3 report').closest('.file-card')!;
    expect(el.getAttribute('title')).toBe('Q3 report\nPDF document · 1.2 MB');
    expect(el.querySelector('a')).toBeNull(); // editable: a click selects, it doesn't navigate
  });

  it('opens the preview on a double-click', () => {
    render(<FileCard {...card()} />);
    fireEvent.doubleClick(screen.getByText('q3.pdf'));
    expect(documentPreview.get()).toEqual({ url: '/api/media/q3.pdf', target: 'q3.pdf', fragment: '', name: 'q3.pdf' });
  });

  it('read-only, it is a link that previews what it can and opens the rest', () => {
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    const { unmount } = render(<FileCard {...card({ interactive: false })} />);
    fireEvent.click(screen.getByRole('link'));
    expect(documentPreview.get()?.target).toBe('q3.pdf');
    unmount();
    act(() => documentPreview.close());
    render(<FileCard {...card({ interactive: false, target: 'deck.pptx', url: '/api/media/deck.pptx', label: 'deck.pptx' })} />);
    const link = screen.getByRole('link');
    expect(link.getAttribute('href')).toBe('/api/media/deck.pptx');
    fireEvent.click(link);
    expect(documentPreview.get()).toBeNull(); // a slide deck isn't previewed: the link opens it
    open.mockRestore();
  });
});

describe('DocumentPreviewHost', () => {
  it('checks a PDF, then frames it at its page', async () => {
    vi.stubGlobal('navigator', { ...navigator, userAgent: 'Mozilla/5.0 Chrome/140', platform: 'Win32', maxTouchPoints: 0, pdfViewerEnabled: true });
    const fetcher = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetcher);
    render(<DocumentPreviewHost />);
    act(() => documentPreview.open({ url: '/api/media/q3.pdf', target: 'q3.pdf', fragment: 'page=3', name: 'Q3 report' }));
    expect(screen.getByRole('dialog', { name: 'Q3 report' })).toBeTruthy();
    const frame = await screen.findByTitle('Q3 report');
    expect(frame.getAttribute('src')).toBe('/api/media/view/q3.pdf#page=3');
    expect(fetcher).toHaveBeenCalledWith('/api/media/view/q3.pdf', expect.objectContaining({ method: 'HEAD' }));
  });

  it('shows a text file as text', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('line one\nline two', { status: 200 })));
    render(<DocumentPreviewHost />);
    act(() => documentPreview.open({ url: '/api/media/notes.md', target: 'notes.md', fragment: '', name: 'notes.md' }));
    await waitFor(() => expect(document.querySelector('.doc-preview__text')?.textContent).toBe('line one\nline two'));
  });

  it('says so — no empty frame — when the file is gone', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 404 })));
    render(<DocumentPreviewHost />);
    act(() => documentPreview.open({ url: '/api/media/q3.pdf', target: 'q3.pdf', fragment: '', name: 'q3.pdf' }));
    await waitFor(() => expect(screen.getByRole('status').textContent).toMatch(/couldn’t be opened|can’t show PDFs/));
    expect(document.querySelector('iframe')).toBeNull();
  });

  it('closes on Escape', () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('x')));
    render(<DocumentPreviewHost />);
    act(() => documentPreview.open({ url: '/api/media/a.txt', target: 'a.txt', fragment: '', name: 'a.txt' }));
    act(() => { fireEvent.keyDown(window, { key: 'Escape' }); });
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
