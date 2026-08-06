import { useCallback, useEffect, useRef, useState } from 'react';

// An optional low-volume ambient loop for focus mode. Generated with WebAudio
// (soft brown noise) so it needs no bundled audio asset. Off by default; the node
// graph is created lazily on first enable and torn down on unmount.
export function useAmbient() {
  const [playing, setPlaying] = useState(false);
  const ctxRef = useRef<AudioContext | null>(null);
  const srcRef = useRef<AudioBufferSourceNode | null>(null);

  const stop = useCallback(() => {
    srcRef.current?.stop();
    srcRef.current = null;
    void ctxRef.current?.close();
    ctxRef.current = null;
    setPlaying(false);
  }, []);

  const start = useCallback(() => {
    const ctx = new AudioContext();
    const frames = 2 * ctx.sampleRate; // 2s loop
    const buffer = ctx.createBuffer(1, frames, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    let last = 0;
    for (let i = 0; i < frames; i++) {
      const white = Math.random() * 2 - 1;
      last = (last + 0.02 * white) / 1.02; // brown-noise integrator
      data[i] = last * 3.5;
    }
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.loop = true;
    const gain = ctx.createGain();
    gain.gain.value = 0.05; // quiet
    src.connect(gain).connect(ctx.destination);
    src.start();
    ctxRef.current = ctx;
    srcRef.current = src;
    setPlaying(true);
  }, []);

  const toggle = useCallback(() => {
    if (srcRef.current) stop();
    else start();
  }, [start, stop]);

  useEffect(() => () => stop(), [stop]);

  return { playing, toggle };
}
