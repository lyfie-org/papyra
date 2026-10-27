import { describe, expect, it } from 'vitest';
import { clock, encodeWav, pickVoiceFormat, voiceFileName, WAV_RATE } from './journalVoice';

describe('voice formats', () => {
  it('prefers WebM/Opus and falls back to what Safari writes', () => {
    expect(pickVoiceFormat(() => true)).toEqual({ mime: 'audio/webm;codecs=opus', ext: '.weba' });
    expect(pickVoiceFormat((m) => m === 'audio/mp4')).toEqual({ mime: 'audio/mp4', ext: '.m4a' });
    expect(pickVoiceFormat((m) => m.startsWith('audio/ogg'))?.ext).toBe('.opus');
  });

  it('says so when the browser records nothing it knows', () => {
    expect(pickVoiceFormat(() => false)).toBeNull();
  });
});

describe('voice file names', () => {
  it('carry the day and the local minute', () => {
    expect(voiceFileName('2026-10-24', new Date(2026, 9, 24, 9, 5), '.weba')).toBe('voice-2026-10-24-0905.weba');
  });

  it('read as a clock', () => {
    expect(clock(0)).toBe('0:00');
    expect(clock(7.9)).toBe('0:07');
    expect(clock(750)).toBe('12:30');
    expect(clock(-3)).toBe('0:00');
  });
});

describe('encodeWav', () => {
  const read = async (samples: number[]) => {
    const blob = encodeWav(Float32Array.from(samples));
    const view = new DataView(await blob.arrayBuffer());
    return { blob, view };
  };
  const tag = (view: DataView, at: number) => String.fromCharCode(...[0, 1, 2, 3].map((i) => view.getUint8(at + i)));

  it('writes a canonical 16 kHz mono 16-bit header', async () => {
    const { blob, view } = await read([0, 0.5, -0.5, 1]);
    expect(blob.type).toBe('audio/wav');
    expect(blob.size).toBe(44 + 4 * 2);
    expect([tag(view, 0), tag(view, 8), tag(view, 12), tag(view, 36)]).toEqual(['RIFF', 'WAVE', 'fmt ', 'data']);
    expect(view.getUint32(4, true)).toBe(36 + 8);
    expect(view.getUint16(20, true)).toBe(1);
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint32(24, true)).toBe(WAV_RATE);
    expect(view.getUint32(28, true)).toBe(WAV_RATE * 2);
    expect(view.getUint16(34, true)).toBe(16);
    expect(view.getUint32(40, true)).toBe(8);
  });

  it('scales samples to 16-bit and clips what is out of range', async () => {
    const { view } = await read([0, 0.5, -0.5, 1, -1, 3, -3]);
    const at = (i: number) => view.getInt16(44 + i * 2, true);
    expect(at(0)).toBe(0);
    expect(at(1)).toBe(0x3fff);
    expect(at(2)).toBe(-0x4000);
    expect(at(3)).toBe(0x7fff);
    expect(at(4)).toBe(-0x8000);
    expect(at(5)).toBe(0x7fff);
    expect(at(6)).toBe(-0x8000);
  });
});
