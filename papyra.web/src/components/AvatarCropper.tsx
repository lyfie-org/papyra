import { useEffect, useRef, useState } from 'react';
import { ZoomIn } from 'lucide-react';
import './AvatarCropper.css';

/** Side of the square that gets uploaded. Big enough for a retina 96px avatar. */
const OUTPUT_PX = 512;
/** Side of the on-screen preview. The crop maths works in these units, then scales. */
const FRAME_PX = 280;

interface Props {
  file: File;
  onCancel: () => void;
  onCropped: (square: Blob) => void | Promise<void>;
}

/**
 * Crops a picture to a square before it is uploaded.
 *
 * Avatars are drawn in circles all over the app, so a portrait photo used to be
 * squashed or centre-cut by CSS with no say from the person in it. Here they
 * choose: drag to move, slide to zoom, and what they see in the frame is exactly
 * what gets sent — a square PNG, re-encoded by the canvas, which also means the
 * bytes reaching the server are ours rather than whatever the file contained.
 */
export default function AvatarCropper({ file, onCancel, onCropped }: Props) {
  const [image, setImage] = useState<HTMLImageElement | null>(null);
  const [zoom, setZoom] = useState(1);
  // Offset of the image centre from the frame centre, in frame pixels.
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [busy, setBusy] = useState(false);
  const dragFrom = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);

  useEffect(() => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => setImage(img);
    img.src = url;
    return () => URL.revokeObjectURL(url);
  }, [file]);

  // The scale at which the picture exactly fills the frame — the floor, so no
  // amount of dragging can expose a transparent corner.
  const cover = image ? Math.max(FRAME_PX / image.width, FRAME_PX / image.height) : 1;
  const scale = cover * zoom;

  function clamp(next: { x: number; y: number }) {
    if (!image) return next;
    // How far the scaled picture overhangs the frame on each side.
    const slackX = Math.max(0, (image.width * scale - FRAME_PX) / 2);
    const slackY = Math.max(0, (image.height * scale - FRAME_PX) / 2);
    return {
      x: Math.min(slackX, Math.max(-slackX, next.x)),
      y: Math.min(slackY, Math.max(-slackY, next.y)),
    };
  }

  function onPointerDown(e: React.PointerEvent) {
    (e.target as Element).setPointerCapture(e.pointerId);
    dragFrom.current = { x: e.clientX, y: e.clientY, ox: offset.x, oy: offset.y };
  }

  function onPointerMove(e: React.PointerEvent) {
    const from = dragFrom.current;
    if (!from) return;
    setOffset(clamp({ x: from.ox + (e.clientX - from.x), y: from.oy + (e.clientY - from.y) }));
  }

  function onPointerUp(e: React.PointerEvent) {
    (e.target as Element).releasePointerCapture(e.pointerId);
    dragFrom.current = null;
  }

  async function apply() {
    if (!image) return;
    setBusy(true);
    try {
      const canvas = document.createElement('canvas');
      canvas.width = OUTPUT_PX;
      canvas.height = OUTPUT_PX;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      // Same transform as the preview, scaled from frame pixels to output pixels,
      // so the crop is what was on screen rather than an approximation of it.
      const k = OUTPUT_PX / FRAME_PX;
      const drawW = image.width * scale * k;
      const drawH = image.height * scale * k;
      ctx.drawImage(
        image,
        OUTPUT_PX / 2 - drawW / 2 + offset.x * k,
        OUTPUT_PX / 2 - drawH / 2 + offset.y * k,
        drawW,
        drawH,
      );

      const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/png'));
      if (blob) await onCropped(blob);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="cropper__scrim" role="presentation" onMouseDown={onCancel}>
      <div
        className="cropper"
        role="dialog"
        aria-modal="true"
        aria-labelledby="cropper-title"
        onMouseDown={e => e.stopPropagation()}
      >
        <h2 id="cropper-title" className="cropper__title">Position your picture</h2>
        <p className="cropper__hint">Drag to move it, and use the slider to zoom. The circle is what people will see.</p>

        <div
          className="cropper__frame"
          style={{ width: FRAME_PX, height: FRAME_PX }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
        >
          {image && (
            <img
              className="cropper__image"
              src={image.src}
              alt=""
              draggable={false}
              style={{
                width: image.width * scale,
                height: image.height * scale,
                transform: `translate(calc(-50% + ${offset.x}px), calc(-50% + ${offset.y}px))`,
              }}
            />
          )}
          <div className="cropper__mask" aria-hidden="true" />
        </div>

        <label className="cropper__zoom">
          <ZoomIn size={16} aria-hidden="true" />
          <span className="cropper__zoom-label">Zoom</span>
          <input
            type="range"
            min={1}
            max={3}
            step={0.01}
            value={zoom}
            onChange={e => {
              setZoom(Number(e.target.value));
              // Zooming out can leave the picture short of an edge; pull it back.
              setOffset(o => clamp(o));
            }}
          />
        </label>

        <div className="cropper__actions">
          <button type="button" className="cropper__btn" onClick={onCancel}>Cancel</button>
          <button
            type="button"
            className="cropper__btn cropper__btn--primary"
            onClick={() => void apply()}
            disabled={!image || busy}
          >
            {busy ? 'Saving…' : 'Use this picture'}
          </button>
        </div>
      </div>
    </div>
  );
}
