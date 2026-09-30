import { heicToJpeg, isHeic } from './heic';
import { mediaKind } from './noteMedia';
import { captureVideoFacts, readAudioFacts } from './videoPoster';

// Everything done to a file in the browser before it is uploaded: an iPhone
// HEIC photo becomes a JPEG where the browser can decode it; a video brings its
// poster frame and size; audio and video bring their running time. The server
// (no ffmpeg) keeps these as the file's metadata, so the embed has its shape
// and a still before the video itself loads.

export interface PreparedUpload {
  file: File;
  poster?: Blob;
  meta?: { width?: number; height?: number; durationMs?: number };
}

function kind(file: File): string {
  if (file.type.startsWith('video/')) return 'video';
  if (file.type.startsWith('audio/')) return 'audio';
  return mediaKind(file.name);
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw new DOMException('Upload cancelled', 'AbortError');
}

export async function prepareUpload(original: File, signal?: AbortSignal): Promise<PreparedUpload> {
  throwIfAborted(signal);
  const file = isHeic(original) ? await heicToJpeg(original) : original;
  throwIfAborted(signal);

  switch (kind(file)) {
    case 'video': {
      const facts = await captureVideoFacts(file);
      throwIfAborted(signal);
      if (!facts) return { file };
      return {
        file,
        poster: facts.poster ?? undefined,
        meta: { width: facts.width, height: facts.height, durationMs: facts.durationMs ?? undefined },
      };
    }
    case 'audio': {
      const facts = await readAudioFacts(file);
      throwIfAborted(signal);
      return facts?.durationMs ? { file, meta: { durationMs: facts.durationMs } } : { file };
    }
    default:
      return { file };
  }
}

/** The multipart body the upload route reads: `file`, then optional `poster` and `meta`. */
export function uploadForm({ file, poster, meta }: PreparedUpload): FormData {
  const form = new FormData();
  form.append('file', file);
  if (poster) form.append('poster', poster, poster.type === 'image/webp' ? 'poster.webp' : 'poster.jpg');
  if (meta) form.append('meta', new Blob([JSON.stringify(meta)], { type: 'application/json' }), 'meta.json');
  return form;
}
