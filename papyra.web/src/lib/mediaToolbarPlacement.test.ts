import { describe, expect, it } from 'vitest';
import { placeBarBeside, placeBarVertically } from './mediaToolbarPlacement';

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

describe('placeBarBeside', () => {
  const sheet = { left: 100, right: 900, top: 100, bottom: 600 };
  const bar = { width: 420, height: 34 };

  it('puts a document card\'s bar to its right, level with it', () => {
    expect(placeBarBeside(bar, { left: 110, right: 230, top: 200, bottom: 290 }, sheet)).toEqual({ left: 236, top: 228 });
  });

  it('to its left when a right-aligned card has no room on the right', () => {
    expect(placeBarBeside(bar, { left: 770, right: 890, top: 200, bottom: 290 }, sheet)).toEqual({ left: 344, top: 228 });
  });

  it('nowhere beside it on a narrow sheet, or when the card is at the edge of the view', () => {
    expect(placeBarBeside(bar, { left: 440, right: 560, top: 200, bottom: 290 }, sheet)).toBeNull();
    expect(placeBarBeside(bar, { left: 110, right: 230, top: 90, bottom: 115 }, sheet)).toBeNull();
  });
});
