// What the browser can tell about a video or audio file before it is uploaded,
// sent along with it (the server has no ffmpeg): a video's poster frame and
// size, and the running time of either. Everything here is best effort — a
// codec the browser can't play, a file that never loads, or a slow machine
// just means the upload goes without it (after at most `timeoutMs`).

export interface VideoFacts {
  /** A still from early in the video, WebP (JPEG where WebP can't be encoded), ≤ `maxWidth` wide. */
  poster: Blob | null;
  width: number;
  height: number;
  durationMs: number | null;
}

export interface AudioFacts {
  durationMs: number | null;
}

const POSTER_MAX_BYTES = 2 * 1024 * 1024; // the server ignores larger posters

function withTimeout<T>(ms: number, work: (done: (value: T) => void, signal: AbortSignal) => void, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    const abort = new AbortController();
    let settled = false;
    const done = (value: T) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      abort.abort();
      resolve(value);
    };
    const timer = setTimeout(() => done(fallback), ms);
    try { work(done, abort.signal); } catch { done(fallback); }
  });
}

function finiteMs(seconds: number): number | null {
  return Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : null;
}

function toBlob(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

/** Encode a frame: WebP where the browser can (Safari silently gives PNG), else JPEG. */
async function encode(canvas: HTMLCanvasElement): Promise<Blob | null> {
  const webp = await toBlob(canvas, 'image/webp', 0.8);
  if (webp?.type === 'image/webp' && webp.size <= POSTER_MAX_BYTES) return webp;
  const jpeg = await toBlob(canvas, 'image/jpeg', 0.82);
  return jpeg && jpeg.size <= POSTER_MAX_BYTES ? jpeg : null;
}

export function captureVideoFacts(
  file: Blob,
  { timeoutMs = 5000, maxWidth = 1280 }: { timeoutMs?: number; maxWidth?: number } = {},
): Promise<VideoFacts | null> {
  return withTimeout<VideoFacts | null>(timeoutMs, (done, signal) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement('video');
    signal.addEventListener('abort', () => {
      video.removeAttribute('src');
      video.load();
      URL.revokeObjectURL(url);
    });
    video.muted = true;
    video.playsInline = true;
    video.preload = 'auto';
    video.onerror = () => done(null);
    video.onloadedmetadata = () => {
      const width = video.videoWidth;
      const height = video.videoHeight;
      if (!width || !height) { done(null); return; }
      const durationMs = finiteMs(video.duration);
      // Early, but past a black first frame: 1s in, or 10% of a short clip.
      const at = durationMs ? Math.min(1, (durationMs / 1000) * 0.1) : 0;
      const facts = { width, height, durationMs };
      video.onseeked = () => {
        const scale = Math.min(1, maxWidth / width);
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(width * scale));
        canvas.height = Math.max(1, Math.round(height * scale));
        const g = canvas.getContext('2d');
        if (!g) { done({ ...facts, poster: null }); return; }
        try {
          g.drawImage(video, 0, 0, canvas.width, canvas.height);
        } catch {
          done({ ...facts, poster: null });
          return;
        }
        void encode(canvas).then((poster) => done({ ...facts, poster }), () => done({ ...facts, poster: null }));
      };
      try { video.currentTime = at; } catch { done({ ...facts, poster: null }); }
    };
    video.src = url;
  }, null);
}

export function readAudioFacts(file: Blob, { timeoutMs = 5000 }: { timeoutMs?: number } = {}): Promise<AudioFacts | null> {
  return withTimeout<AudioFacts | null>(timeoutMs, (done, signal) => {
    const url = URL.createObjectURL(file);
    const audio = document.createElement('audio');
    signal.addEventListener('abort', () => {
      audio.removeAttribute('src');
      audio.load();
      URL.revokeObjectURL(url);
    });
    audio.preload = 'metadata';
    audio.onerror = () => done(null);
    audio.onloadedmetadata = () => done({ durationMs: finiteMs(audio.duration) });
    audio.src = url;
  }, null);
}
