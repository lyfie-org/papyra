import { useCallback, useEffect, useRef, useState } from 'react';
import { Minus, Plus, RotateCcw } from 'lucide-react';
import { MAX_ZOOM, clampView, coverScale, minZoom, type CropView } from '../lib/cropMath';
import './AvatarCropper.css';

/** Side of the square that gets uploaded. Big enough for a retina 128px avatar. */
const OUTPUT_PX = 512;
/** Largest on-screen crop frame; smaller on a narrow phone. */
const MAX_FRAME_PX = 320;

interface Props {
  file: File;
  onCancel: () => void;
  onCropped: (square: Blob) => void | Promise<void>;
}

type View = CropView;

/**
 * Frames a picture for the circle it will be shown in, then crops it to a square.
 *
 * The first version clamped the picture so it always covered the whole square
 * frame. That sounds tidy, but a photo whose face sits near the top edge could
 * then never be moved down far enough to put the face in the circle — the clamp
 * stopped it exactly when the person needed it. Now the picture moves freely
 * until its edge reaches the centre, and can be zoomed out until all of it is in
 * view. Whatever the photo no longer covers is filled with a soft, blurred copy
 * of itself (the way phone OSes frame a photo that doesn't fit), so the avatar
 * never has a hard empty edge. The preview and the upload are drawn by the same
 * function, so what is in the frame is exactly what is sent — a square PNG
 * re-encoded by the canvas, never the original file's bytes.
 */
export default function AvatarCropper({ file, onCancel, onCropped }: Props) {
  const [image, setImage] = useState<HTMLImageElement | null>(null);
  const [frame] = useState(() =>
    Math.max(200, Math.min(MAX_FRAME_PX, (typeof window === 'undefined' ? MAX_FRAME_PX : window.innerWidth) - 96)));
  const [view, setView] = useState<View>({ zoom: 1, x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dragFrom = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const previewLg = useRef<HTMLCanvasElement>(null);
  const previewSm = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => setImage(img);
    img.onerror = () => setError('That picture couldn’t be opened. Try a PNG, JPEG or WebP.');
    img.src = url;
    return () => {
      // Detach first: revoking the URL makes a still-loading image fire onerror,
      // which (under StrictMode's double effect) reported a perfectly good photo
      // as unopenable.
      img.onload = null;
      img.onerror = null;
      URL.revokeObjectURL(url);
    };
  }, [file]);

  // Zoom is relative to `cover` (1 = the photo fills the frame); the floor shows
  // the whole photo. See lib/cropMath for the framing rules.
  const cover = image ? coverScale(image.width, image.height, frame) : 1;
  const floor = image ? minZoom(image.width, image.height, frame) : 1;

  const clamp = useCallback(
    (v: View): View => (image ? clampView(v, image.width, image.height, frame) : v),
    [image, frame],
  );

  const update = useCallback((fn: (v: View) => View) => setView((v) => clamp(fn(v))), [clamp]);

  /** Draw the framed picture onto a square canvas of `size` pixels. */
  const draw = useCallback((ctx: CanvasRenderingContext2D, size: number) => {
    if (!image) return;
    const k = size / frame;
    ctx.clearRect(0, 0, size, size);

    // Backdrop: the picture again, filling the square, blurred and softened.
    const bw = image.width * cover * k * 1.12;
    const bh = image.height * cover * k * 1.12;
    ctx.save();
    ctx.filter = `blur(${Math.max(2, size * 0.045)}px) saturate(1.1)`;
    ctx.drawImage(image, (size - bw) / 2, (size - bh) / 2, bw, bh);
    ctx.restore();
    ctx.fillStyle = 'rgba(0, 0, 0, 0.12)';
    ctx.fillRect(0, 0, size, size);

    const s = cover * view.zoom * k;
    const dw = image.width * s;
    const dh = image.height * s;
    ctx.drawImage(image, size / 2 - dw / 2 + view.x * k, size / 2 - dh / 2 + view.y * k, dw, dh);
  }, [image, frame, cover, view]);

  // Live previews of the result at the sizes it will actually appear.
  useEffect(() => {
    for (const canvas of [previewLg.current, previewSm.current]) {
      const ctx = canvas?.getContext('2d');
      if (canvas && ctx) draw(ctx, canvas.width);
    }
  }, [draw]);

  // ── Pointer, wheel, keyboard ─────────────────────────────────────────────

  function onPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    if (!image) return;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    dragFrom.current = { x: e.clientX, y: e.clientY, ox: view.x, oy: view.y };
    setDragging(true);
  }
  function onPointerMove(e: React.PointerEvent<HTMLDivElement>) {
    const from = dragFrom.current;
    if (!from) return;
    update((v) => ({ ...v, x: from.ox + (e.clientX - from.x), y: from.oy + (e.clientY - from.y) }));
  }
  function endDrag() { dragFrom.current = null; setDragging(false); }

  // Wheel zoom. Registered natively (passive: false) so the page doesn't scroll.
  useEffect(() => {
    const el = frameRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      update((v) => ({ ...v, zoom: v.zoom * Math.exp(-e.deltaY * 0.0015) }));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [update]);

  function onKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    const step = e.shiftKey ? 20 : 4;
    const moves: Record<string, [number, number]> = {
      ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step],
    };
    if (e.key in moves) {
      e.preventDefault();
      const [dx, dy] = moves[e.key];
      update((v) => ({ ...v, x: v.x + dx, y: v.y + dy }));
    } else if (e.key === '+' || e.key === '=') { e.preventDefault(); update((v) => ({ ...v, zoom: v.zoom * 1.1 })); }
    else if (e.key === '-' || e.key === '_') { e.preventDefault(); update((v) => ({ ...v, zoom: v.zoom / 1.1 })); }
    else if (e.key === '0') { e.preventDefault(); setView({ zoom: 1, x: 0, y: 0 }); }
  }

  // Esc cancels (the scrim click already does).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onCancel(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  async function apply() {
    if (!image) return;
    setBusy(true);
    setError(null);
    try {
      const canvas = document.createElement('canvas');
      canvas.width = OUTPUT_PX;
      canvas.height = OUTPUT_PX;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('no canvas');
      draw(ctx, OUTPUT_PX);
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
      if (!blob) throw new Error('encode failed');
      await onCropped(blob);
    } catch (e) {
      // The server's own reason (too large, not an image) when it gave one.
      const msg = e instanceof Error ? e.message : '';
      setError(msg && !['no canvas', 'encode failed', 'upload failed'].includes(msg)
        ? msg
        : 'Couldn’t save that picture. Try again.');
    } finally {
      setBusy(false);
    }
  }

  const s = cover * view.zoom;
  const zoomPct = Math.round(((view.zoom - floor) / (MAX_ZOOM - floor || 1)) * 100);

  return (
    <div className="cropper__scrim" role="presentation" onMouseDown={onCancel}>
      <div
        className="cropper"
        role="dialog"
        aria-modal="true"
        aria-labelledby="cropper-title"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header className="cropper__head">
          <h2 id="cropper-title" className="cropper__title">Frame your photo</h2>
          <p className="cropper__hint">Drag to move · scroll or use the slider to zoom</p>
        </header>

        <div
          ref={frameRef}
          className={`cropper__frame${dragging ? ' is-dragging' : ''}`}
          style={{ width: frame, height: frame }}
          tabIndex={0}
          role="application"
          aria-label="Photo position. Arrow keys move it, plus and minus zoom, 0 resets."
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onKeyDown={onKeyDown}
          onDoubleClick={() => setView({ zoom: 1, x: 0, y: 0 })}
        >
          {image && (
            <>
              <img
                className="cropper__backdrop"
                src={image.src}
                alt=""
                draggable={false}
                style={{ width: image.width * cover * 1.12, height: image.height * cover * 1.12 }}
              />
              <img
                className="cropper__image"
                src={image.src}
                alt=""
                draggable={false}
                style={{
                  width: image.width * s,
                  height: image.height * s,
                  transform: `translate(calc(-50% + ${view.x}px), calc(-50% + ${view.y}px))`,
                }}
              />
            </>
          )}
          {!image && !error && <span className="cropper__loading">Opening…</span>}
          <div className="cropper__mask" aria-hidden="true">
            <span className="cropper__grid" />
          </div>
        </div>

        <div className="cropper__zoom">
          <button
            type="button"
            className="cropper__icon"
            aria-label="Zoom out"
            disabled={!image || view.zoom <= floor + 1e-3}
            onClick={() => update((v) => ({ ...v, zoom: v.zoom / 1.15 }))}
          >
            <Minus size={16} />
          </button>
          <input
            type="range"
            aria-label="Zoom"
            min={floor}
            max={MAX_ZOOM}
            step={0.01}
            value={view.zoom}
            disabled={!image}
            style={{ '--fill': `${zoomPct}%` } as React.CSSProperties}
            onChange={(e) => { const zoom = Number(e.target.value); update((v) => ({ ...v, zoom })); }}
          />
          <button
            type="button"
            className="cropper__icon"
            aria-label="Zoom in"
            disabled={!image || view.zoom >= MAX_ZOOM - 1e-3}
            onClick={() => update((v) => ({ ...v, zoom: v.zoom * 1.15 }))}
          >
            <Plus size={16} />
          </button>
        </div>

        <div className="cropper__foot">
          <div className="cropper__previews" aria-label="Preview">
            <canvas ref={previewLg} width={112} height={112} className="cropper__preview cropper__preview--lg" />
            <canvas ref={previewSm} width={76} height={76} className="cropper__preview cropper__preview--sm" />
          </div>
          <button
            type="button"
            className="cropper__reset"
            onClick={() => setView({ zoom: 1, x: 0, y: 0 })}
            disabled={!image || (view.zoom === 1 && view.x === 0 && view.y === 0)}
          >
            <RotateCcw size={14} /> Reset
          </button>
        </div>

        {error && <p className="cropper__error" role="alert">{error}</p>}

        <div className="cropper__actions">
          <button type="button" className="cropper__btn" onClick={onCancel}>Cancel</button>
          <button
            type="button"
            className="cropper__btn cropper__btn--primary"
            onClick={() => void apply()}
            disabled={!image || busy}
          >
            {busy ? 'Saving…' : 'Save photo'}
          </button>
        </div>
      </div>
    </div>
  );
}
