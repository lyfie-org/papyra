// Voice notes: what a browser can record, what the file is called, and the WAV
// the server's transcriber reads (it decodes nothing else in-process).

/** The longest one recording runs, so a forgotten tab doesn't fill the vault. */
export const MAX_VOICE_SECONDS = 600;

/** Whisper listens at 16 kHz, mono; anything finer is wasted bytes. */
export const WAV_RATE = 16_000;

export interface VoiceFormat {
  mime: string;
  /** The file extension the server sniffs this container under. */
  ext: '.weba' | '.m4a' | '.opus';
}

/**
 * Best first: Chrome, Edge and Firefox write WebM/Opus, Safari writes MP4/AAC
 * (older ones can't do WebM at all). The extension tells the server which kind
 * of container a bare EBML or `ftyp` header is — audio, not video.
 */
const FORMATS: VoiceFormat[] = [
  { mime: 'audio/webm;codecs=opus', ext: '.weba' },
  { mime: 'audio/webm', ext: '.weba' },
  { mime: 'audio/mp4', ext: '.m4a' },
  { mime: 'audio/ogg;codecs=opus', ext: '.opus' },
];

/** The first format this browser records, or null when it can't record at all. */
export function pickVoiceFormat(isTypeSupported: (mime: string) => boolean): VoiceFormat | null {
  return FORMATS.find((f) => isTypeSupported(f.mime)) ?? null;
}

/** Whether this page can record: a microphone API and a recorder that knows a format. */
export function canRecordVoice(): boolean {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) return false;
  if (typeof MediaRecorder === 'undefined') return false;
  return pickVoiceFormat((m) => MediaRecorder.isTypeSupported(m)) !== null;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** `voice-2026-10-24-1432.weba`: the day it belongs to and the minute it was made. */
export function voiceFileName(day: string, now: Date, ext: string): string {
  return `voice-${day}-${pad(now.getHours())}${pad(now.getMinutes())}${ext}`;
}

/** `0:07`, `12:30`. */
export function clock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${pad(s % 60)}`;
}

/** 16-bit PCM, mono, with a canonical 44-byte RIFF header. */
export function encodeWav(samples: Float32Array, sampleRate: number = WAV_RATE): Blob {
  const bytes = samples.length * 2;
  const buffer = new ArrayBuffer(44 + bytes);
  const view = new DataView(buffer);
  const text = (at: number, s: string) => { for (let i = 0; i < s.length; i++) view.setUint8(at + i, s.charCodeAt(i)); };
  text(0, 'RIFF');
  view.setUint32(4, 36 + bytes, true);
  text(8, 'WAVE');
  text(12, 'fmt ');
  view.setUint32(16, 16, true);          // fmt chunk size
  view.setUint16(20, 1, true);           // PCM
  view.setUint16(22, 1, true);           // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true);           // block align
  view.setUint16(34, 16, true);          // bits per sample
  text(36, 'data');
  view.setUint32(40, bytes, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([buffer], { type: 'audio/wav' });
}

/** A recording as 16 kHz mono WAV, for the server to transcribe. Browser only. */
export async function toWav(recording: Blob): Promise<Blob> {
  const context = new AudioContext();
  try {
    const decoded = await context.decodeAudioData(await recording.arrayBuffer());
    const frames = Math.max(1, Math.ceil(decoded.duration * WAV_RATE));
    const offline = new OfflineAudioContext(1, frames, WAV_RATE);
    const source = offline.createBufferSource();
    source.buffer = decoded;
    source.connect(offline.destination); // the offline mono destination mixes the channels down
    source.start();
    const rendered = await offline.startRendering();
    return encodeWav(rendered.getChannelData(0), WAV_RATE);
  } finally {
    void context.close();
  }
}
