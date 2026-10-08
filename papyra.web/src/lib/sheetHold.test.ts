import { describe, expect, it } from 'vitest';
import { fillsSheet } from './sheetHold';

describe('fillsSheet', () => {
  const pictures = (n: number) => Array.from({ length: n }, (_, i) => `Picture ${i}\n\n![[p-${i}.png]]`).join('\n\n');

  it('holds a note sure to overflow the sheet', () => {
    expect(fillsSheet(pictures(200), 900)).toBe(true);
    expect(fillsSheet(Array.from({ length: 60 }, (_, i) => `Line ${i}`).join('\n'), 900)).toBe(true);
  });

  it('leaves short and empty notes to size themselves', () => {
    expect(fillsSheet('', 900)).toBe(false);
    expect(fillsSheet('A few words.\n\n- one\n- two', 900)).toBe(false);
    expect(fillsSheet(pictures(2), 900)).toBe(false);
    // Blank lines take no room of their own.
    expect(fillsSheet('\n'.repeat(500), 900)).toBe(false);
  });

  it('measures against the window it opens in', () => {
    const body = Array.from({ length: 20 }, (_, i) => `Line ${i}`).join('\n');
    expect(fillsSheet(body, 1400)).toBe(false);
    expect(fillsSheet(body, 600)).toBe(true);
  });
});
