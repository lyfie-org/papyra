// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMediaToolbarItems } from './mediaToolbar';
import { toMediaMeta } from './mediaMeta';

// Papyra's buttons on a selected attachment. "Copy text" appears once the
// server has read words out of the file (OCR / transcript) and copies them.

const ctx = (meta: unknown, over: Record<string, unknown> = {}) => ({
  target: 'receipt.png', fragment: '', kind: 'image', url: '/api/media/receipt.png',
  meta: meta as never, update: vi.fn(), remove: vi.fn(), ...over,
});

let writeText: ReturnType<typeof vi.fn>;
beforeEach(() => {
  writeText = vi.fn(async () => {});
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('Copy text', () => {
  const upload = vi.fn();

  it('appears only when the file has read-out text', () => {
    const items = createMediaToolbarItems({ upload });
    expect(items(ctx(toMediaMeta({ kind: 'image' }))).map((i) => i.id)).not.toContain('papyra.copy-text');
    const withText = items(ctx(toMediaMeta({ kind: 'image', text: 'ocr' })));
    expect(withText.find((i) => i.id === 'papyra.copy-text')?.label).toBe('Copy text in picture');
    const audio = items(ctx(toMediaMeta({ kind: 'audio', text: 'transcript' }), { kind: 'audio' }));
    expect(audio.find((i) => i.id === 'papyra.copy-text')?.label).toBe('Copy transcript');
  });

  it('is not offered on a shared (read-only) note', () => {
    const items = createMediaToolbarItems({ upload, readOnly: true });
    expect(items(ctx(toMediaMeta({ kind: 'image', text: 'ocr' }))).map((i) => i.id)).not.toContain('papyra.copy-text');
  });

  it('copies the words and says how many', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ kind: 'ocr', text: 'TOTAL DUE 42.00' }))));
    const notify = vi.fn();
    const item = createMediaToolbarItems({ upload, notify })(ctx(toMediaMeta({ kind: 'image', text: 'ocr' })))
      .find((i) => i.id === 'papyra.copy-text')!;
    item.onSelect();
    await vi.waitFor(() => expect(notify).toHaveBeenCalledWith('Text copied (3 words)'));
    expect(writeText).toHaveBeenCalledWith('TOTAL DUE 42.00');
    expect(fetch).toHaveBeenCalledWith('/api/media/receipt.png/text', expect.anything());
  });

  it('says so when the text is gone', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 404 })));
    const notify = vi.fn();
    createMediaToolbarItems({ upload, notify })(ctx(toMediaMeta({ kind: 'image', text: 'ocr' })))
      .find((i) => i.id === 'papyra.copy-text')!.onSelect();
    await vi.waitFor(() => expect(notify).toHaveBeenCalledWith('Couldn’t copy the text.'));
  });
});
