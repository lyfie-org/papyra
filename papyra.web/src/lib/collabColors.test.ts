import { describe, expect, it } from 'vitest';
import { COLLAB_COLOR_COUNT, collabColor, collabColorIndex } from './collabColors';

describe('collabColorIndex', () => {
  it('is stable per person and within the token range', () => {
    for (const name of ['bea', 'rahul', 'Ω', '', 'a-very-long-username-indeed']) {
      const i = collabColorIndex(name);
      expect(i).toBe(collabColorIndex(name));
      expect(i).toBeGreaterThanOrEqual(1);
      expect(i).toBeLessThanOrEqual(COLLAB_COLOR_COUNT);
    }
  });

  it('spreads people over the palette', () => {
    const used = new Set(Array.from({ length: 64 }, (_, n) => collabColorIndex(`user${n}`)));
    expect(used.size).toBe(COLLAB_COLOR_COUNT);
  });

  it('is a token reference, resolved by each viewer’s own theme', () => {
    expect(collabColor('bea')).toMatch(/^var\(--collab-[1-8]\)$/);
  });
});
