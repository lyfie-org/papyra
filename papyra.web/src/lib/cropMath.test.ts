import { describe, expect, it } from 'vitest';
import { MAX_ZOOM, clampView, coverScale, minZoom } from './cropMath';

const FRAME = 320;

describe('crop framing', () => {
  it('zoom 1 fills the frame; the floor fits the whole photo', () => {
    // Landscape 1600×1200: cover fits height, contain fits width.
    expect(coverScale(1600, 1200, FRAME)).toBeCloseTo(FRAME / 1200);
    const floor = minZoom(1600, 1200, FRAME);
    expect(floor).toBeCloseTo(1200 / 1600);
    const s = coverScale(1600, 1200, FRAME) * floor;
    expect(1600 * s).toBeCloseTo(FRAME); // whole width visible
    // A square photo can't zoom out past filling.
    expect(minZoom(800, 800, FRAME)).toBe(1);
  });

  it('lets a face at the top edge be moved down into the circle (the reported bug)', () => {
    // Square-ish photo filling the frame at zoom 1: the old clamp allowed zero
    // vertical movement, so a head cut off at the top could never be centred.
    const w = 1000, h = 1000;
    const wanted = { zoom: 1, x: 0, y: 120 }; // drag the photo 120px down
    const v = clampView(wanted, w, h, FRAME);
    expect(v.y).toBe(120);
    // ...all the way until the photo's top edge reaches the centre, no further.
    expect(clampView({ zoom: 1, x: 0, y: 10_000 }, w, h, FRAME).y).toBeCloseTo(FRAME / 2);
    expect(clampView({ zoom: 1, x: -10_000, y: 0 }, w, h, FRAME).x).toBeCloseTo(-FRAME / 2);
  });

  it('can bring every corner of the photo into view', () => {
    const w = 1600, h = 1200;
    const s = coverScale(w, h, FRAME);
    const v = clampView({ zoom: 1, x: 10_000, y: 10_000 }, w, h, FRAME);
    // Top-left corner of the photo, in frame coordinates relative to centre:
    const cornerX = v.x - (w * s) / 2;
    const cornerY = v.y - (h * s) / 2;
    expect(cornerX).toBeCloseTo(0);
    expect(cornerY).toBeCloseTo(0);
  });

  it('clamps zoom to [floor, MAX_ZOOM] and shrinks the move range with it', () => {
    expect(clampView({ zoom: 99, x: 0, y: 0 }, 1000, 1000, FRAME).zoom).toBe(MAX_ZOOM);
    expect(clampView({ zoom: 0.01, x: 0, y: 0 }, 1600, 1200, FRAME).zoom).toBeCloseTo(0.75);
    const zoomedOut = clampView({ zoom: 0.75, x: 10_000, y: 0 }, 1600, 1200, FRAME);
    expect(zoomedOut.x).toBeCloseTo(FRAME / 2);
  });

  it('never produces NaN for a degenerate 1×1 image', () => {
    const v = clampView({ zoom: 1, x: 5, y: 5 }, 1, 1, FRAME);
    expect(Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.zoom)).toBe(true);
  });
});
