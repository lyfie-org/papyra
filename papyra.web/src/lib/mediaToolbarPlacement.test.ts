import { describe, expect, it } from 'vitest';
import { placeBarVertically } from './mediaToolbarPlacement';

// A note panel shows 100–600; a 40px attachment bar.
const view = { top: 100, bottom: 600 };

describe('placeBarVertically', () => {
  it('leaves a bar that is fully visible where it is', () => {
    expect(placeBarVertically(208, 40, { top: 200, bottom: 400 }, view)).toBe(208);
  });

  it('rides the visible part of a picture whose top has scrolled away', () => {
    // Picture 0–500: its in-picture bar at 8 is above the panel's top.
    expect(placeBarVertically(8, 40, { top: 0, bottom: 500 }, view)).toBe(108);
  });

  it('moves a bar under a small picture at the foot of the panel to above it', () => {
    // Picture 520–590, bar below it at 596 → cut off; above it (474) fits.
    expect(placeBarVertically(596, 40, { top: 520, bottom: 590 }, view)).toBe(474);
  });

  it('a card at the very top gets its bar below it instead of above', () => {
    expect(placeBarVertically(56, 40, { top: 102, bottom: 180 }, view)).toBe(186);
  });
});
