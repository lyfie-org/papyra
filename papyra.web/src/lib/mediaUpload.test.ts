// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { checkMediaFile, loadMediaLimits, setMediaLimits, type MediaLimitTable } from './mediaLimits';
import { heicToJpeg, isHeic } from './heic';
import { prepareUpload, uploadForm } from './uploadPrep';
import * as poster from './videoPoster';
import { pauseOffscreenVideos } from './videoVisibility';

const MB = 1024 * 1024;
const TABLE: MediaLimitTable = {
  limits: { image: 30 * MB, gif: 50 * MB, audio: 100 * MB, video: 500 * MB, document: 100 * MB, other: 50 * MB },
  extensions: { image: ['.png', '.jpg', '.heic'], audio: ['.mp3'], video: ['.mp4'], document: ['.pdf'] },
};

function sized(name: string, bytes: number, type = '') {
  const file = new File(['x'], name, { type });
  Object.defineProperty(file, 'size', { value: bytes });
  return file;
}

afterEach(() => { setMediaLimits(null); vi.restoreAllMocks(); });

describe('checkMediaFile', () => {
  it('refuses a file over its kind\'s limit, in the server\'s words', () => {
    expect(checkMediaFile(sized('clip.mp4', 501 * MB), TABLE)).toBe('That video is over the 500 MB limit for videos.');
    expect(checkMediaFile(sized('Photo.JPG', 31 * MB), TABLE)).toBe('That image is over the 30 MB limit for images.');
    expect(checkMediaFile(sized('loop.gif', 51 * MB), TABLE)).toBe('That GIF is over the 50 MB limit for GIFs.');
    expect(checkMediaFile(sized('blob.bin', 51 * MB), TABLE)).toBe('That file is over the 50 MB limit for files.');
  });

  it('lets through what fits — and everything while the table is unknown', () => {
    expect(checkMediaFile(sized('clip.mp4', 400 * MB), TABLE)).toBeNull();
    expect(checkMediaFile(sized('clip.mp4', 900 * MB), null)).toBeNull();
  });

  it('refuses an empty file', () => {
    expect(checkMediaFile(sized('empty.png', 0), TABLE)).toMatch(/empty/);
  });

  it('loads the table once from the server', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify(TABLE)));
    await loadMediaLimits(fetcher as unknown as typeof fetch);
    await loadMediaLimits(fetcher as unknown as typeof fetch);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(checkMediaFile(sized('clip.mp4', 501 * MB))).toMatch(/500 MB/);
  });
});

describe('heic', () => {
  it('recognises HEIC by name or type', () => {
    expect(isHeic(new File([''], 'IMG_0001.HEIC'))).toBe(true);
    expect(isHeic(new File([''], 'photo', { type: 'image/heif' }))).toBe(true);
    expect(isHeic(new File([''], 'photo.jpg'))).toBe(false);
  });

  it('uploads the original when this browser can\'t decode it', async () => {
    const file = new File(['x'], 'IMG_0001.heic', { type: 'image/heic' });
    vi.stubGlobal('createImageBitmap', vi.fn(async () => { throw new DOMException('no', 'InvalidStateError'); }));
    expect(await heicToJpeg(file)).toBe(file);
    vi.unstubAllGlobals();
  });

  it('becomes a .jpg where it can', async () => {
    const file = new File(['x'], 'IMG_0001.heic', { type: 'image/heic' });
    vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width: 4, height: 3, close: vi.fn() })));
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage: vi.fn() } as never);
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(function (cb) { cb(new Blob(['j'], { type: 'image/jpeg' })); });
    const out = await heicToJpeg(file);
    expect(out.name).toBe('IMG_0001.jpg');
    expect(out.type).toBe('image/jpeg');
    vi.unstubAllGlobals();
  });
});

describe('prepareUpload', () => {
  it('sends a video with its poster and measurements', async () => {
    const still = new Blob(['p'], { type: 'image/webp' });
    vi.spyOn(poster, 'captureVideoFacts').mockResolvedValue({ poster: still, width: 1920, height: 1080, durationMs: 4200 });
    const prepared = await prepareUpload(new File(['v'], 'clip.mp4', { type: 'video/mp4' }));
    expect(prepared.poster).toBe(still);
    expect(prepared.meta).toEqual({ width: 1920, height: 1080, durationMs: 4200 });

    const form = uploadForm(prepared);
    expect((form.get('file') as File).name).toBe('clip.mp4');
    expect((form.get('poster') as File).name).toBe('poster.webp');
    expect(JSON.parse(await (form.get('meta') as Blob).text())).toEqual({ width: 1920, height: 1080, durationMs: 4200 });
  });

  it('still uploads a video the browser can\'t read', async () => {
    vi.spyOn(poster, 'captureVideoFacts').mockResolvedValue(null);
    const file = new File(['v'], 'clip.mkv', { type: 'video/x-matroska' });
    const prepared = await prepareUpload(file);
    expect(prepared).toEqual({ file });
    expect([...uploadForm(prepared).keys()]).toEqual(['file']);
  });

  it('sends audio with its running time, and leaves other files alone', async () => {
    vi.spyOn(poster, 'readAudioFacts').mockResolvedValue({ durationMs: 61_000 });
    expect((await prepareUpload(new File(['a'], 'song.mp3', { type: 'audio/mpeg' }))).meta).toEqual({ durationMs: 61_000 });
    const pdf = new File(['%PDF'], 'doc.pdf', { type: 'application/pdf' });
    expect(await prepareUpload(pdf)).toEqual({ file: pdf });
  });

  it('stops when the upload is cancelled while preparing', async () => {
    const abort = new AbortController();
    vi.spyOn(poster, 'captureVideoFacts').mockImplementation(async () => { abort.abort(); return null; });
    await expect(prepareUpload(new File(['v'], 'clip.mp4', { type: 'video/mp4' }), abort.signal))
      .rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('pauseOffscreenVideos', () => {
  let callback: IntersectionObserverCallback;
  const observed = new Set<Element>();
  beforeEach(() => {
    observed.clear();
    vi.stubGlobal('IntersectionObserver', class {
      constructor(cb: IntersectionObserverCallback) { callback = cb; }
      observe(el: Element) { observed.add(el); }
      unobserve(el: Element) { observed.delete(el); }
      disconnect() {}
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('pauses a playing video that scrolls away, and never starts one', async () => {
    const box = document.createElement('div');
    const video = document.createElement('video');
    box.append(video);
    document.body.append(box);
    const stop = pauseOffscreenVideos(box);
    expect(observed.has(video)).toBe(true);

    Object.defineProperty(video, 'paused', { value: false, configurable: true });
    const pause = vi.spyOn(video, 'pause').mockImplementation(() => {});
    const play = vi.spyOn(video, 'play');
    callback([{ target: video, isIntersecting: false } as unknown as IntersectionObserverEntry], {} as IntersectionObserver);
    expect(pause).toHaveBeenCalledTimes(1);
    callback([{ target: video, isIntersecting: true } as unknown as IntersectionObserverEntry], {} as IntersectionObserver);
    expect(play).not.toHaveBeenCalled();

    // Videos the editor adds later are watched too; removed ones are let go.
    const later = document.createElement('video');
    box.append(later);
    await Promise.resolve();
    expect(observed.has(later)).toBe(true);
    later.remove();
    await Promise.resolve();
    expect(observed.has(later)).toBe(false);

    stop();
    expect(observed.size).toBe(0);
    box.remove();
  });
});
