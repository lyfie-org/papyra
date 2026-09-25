// Pure geometry behind AvatarCropper. Frame units: on-screen pixels of the
// square crop frame; the offset is the photo centre's distance from the frame
// centre. Kept separate so the rules that decide what a person may frame are
// testable without a canvas.

export const MAX_ZOOM = 4;

export interface CropView { zoom: number; x: number; y: number }

/** Scale at which the photo exactly fills the frame (zoom 1). */
export function coverScale(w: number, h: number, frame: number): number {
  return Math.max(frame / w, frame / h);
}

/** Lowest zoom: the whole photo fits inside the frame. Never above 1. */
export function minZoom(w: number, h: number, frame: number): number {
  const contain = Math.min(frame / w, frame / h);
  return Math.min(1, contain / coverScale(w, h, frame));
}

/**
 * Keep a view within what can be framed: zoom between "whole photo" and
 * MAX_ZOOM, and the photo free to move until its edge reaches the centre of the
 * circle — so any part of it, corners included, can be brought into the circle,
 * but it can never be dragged out entirely.
 */
export function clampView(v: CropView, w: number, h: number, frame: number): CropView {
  const zoom = Math.min(MAX_ZOOM, Math.max(minZoom(w, h, frame), v.zoom));
  const s = coverScale(w, h, frame) * zoom;
  const limitX = (w * s) / 2;
  const limitY = (h * s) / 2;
  return {
    zoom,
    x: Math.min(limitX, Math.max(-limitX, v.x)),
    y: Math.min(limitY, Math.max(-limitY, v.y)),
  };
}
