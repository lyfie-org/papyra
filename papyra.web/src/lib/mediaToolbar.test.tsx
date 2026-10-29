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

describe('Replace and Rename', () => {
  const upload = vi.fn();
  const ids = (over: Record<string, unknown>, deps: { readOnly?: boolean } = {}) =>
    createMediaToolbarItems({ upload, ...deps })(ctx(null, { requestInput: vi.fn(), ...over })).map((i) => i.id);

  it('a recording can be renamed but not replaced', () => {
    const audio = ids({ kind: 'audio', target: 'voice-1.wav' });
    expect(audio).toContain('papyra.rename');
    expect(audio).not.toContain('papyra.replace');
  });

  it('a picture can be replaced but is not renamed', () => {
    const image = ids({ kind: 'image' });
    expect(image).toContain('papyra.replace');
    expect(image).not.toContain('papyra.rename');
  });

  it('a document can be renamed and replaced', () => {
    const doc = ids({ kind: 'pdf', target: 'q3.pdf' });
    expect(doc).toEqual(expect.arrayContaining(['papyra.rename', 'papyra.replace']));
  });

  it('a read-only view offers neither', () => {
    const readOnly = ids({ kind: 'audio', target: 'voice-1.wav' }, { readOnly: true });
    expect(readOnly).not.toContain('papyra.rename');
    expect(readOnly).not.toContain('papyra.replace');
  });

  it('naming a recording writes the name into the embed, and the file name clears it', async () => {
    const update = vi.fn();
    const ask = vi.fn(async () => ({ name: 'Walk, Tuesday' }));
    const rename = createMediaToolbarItems({ upload })(ctx(null, { kind: 'audio', target: 'voice-1.wav', update, requestInput: ask }))
      .find((i) => i.id === 'papyra.rename')!;
    rename.onSelect();
    await vi.waitFor(() => expect(update).toHaveBeenCalledWith({ alt: 'Walk, Tuesday' }));
    ask.mockResolvedValueOnce({ name: 'voice-1.wav' });
    rename.onSelect();
    await vi.waitFor(() => expect(update).toHaveBeenCalledWith({ alt: null }));
  });
});
