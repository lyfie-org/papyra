import { describe, expect, it } from 'vitest';
import { NOTE_SWATCHES, tintInk, tintInkClass } from './noteColors';

describe('tintInk', () => {
  it('keeps dark ink on every palette pastel, in both themes', () => {
    for (const { value } of NOTE_SWATCHES) {
      if (!value) continue;
      expect(tintInk(value, 'light')).toBe('dark');
      expect(tintInk(value, 'dark')).toBe('dark');
    }
  });

  it('switches to light ink on a dark custom colour', () => {
    expect(tintInk('#1f2a44', 'light')).toBe('light');
    expect(tintInk('#1f2a44', 'dark')).toBe('light');
    expect(tintInk('#000', 'light')).toBe('light');
  });

  it('judges the colour as painted: dark mode mixes it toward the surface', () => {
    // A mid tone that still takes dark ink in light mode tips to light ink once
    // dark mode mixes it 78% toward the graphite surface.
    expect(tintInk('#8a8f98', 'light')).toBe('dark');
    expect(tintInk('#8a8f98', 'dark')).toBe('light');
  });

  it('keeps the default for no colour or one it cannot read', () => {
    expect(tintInk(null, 'dark')).toBe('dark');
    expect(tintInk('', 'light')).toBe('dark');
    expect(tintInk('not-a-colour', 'light')).toBe('dark');
  });

  it('reads 3- and 8-digit hex', () => {
    expect(tintInk('#fff', 'light')).toBe('dark');
    expect(tintInk('#101820ff', 'light')).toBe('light');
  });

  it('names the class only for light ink', () => {
    expect(tintInkClass('#1f2a44', 'light')).toBe(' tint--light-ink');
    expect(tintInkClass('#dfe9df', 'light')).toBe('');
  });

  it('steps a mid-tone up to pure ink when neither warm ink reaches 4.5:1', () => {
    // #8a8f98 painted in dark mode: best warm ink is only 3.6:1; pure black
    // (4.7:1) edges out pure white (4.5:1).
    expect(tintInkClass('#8a8f98', 'dark')).toBe(' tint--high-ink');
    expect(tintInkClass(null, 'dark')).toBe('');
  });
});

describe('palette', () => {
  it('keeps every swatch clearly distinct (no near-twins)', async () => {
    const { NOTE_SWATCHES: all } = await import('./noteColors');
    const values = all.map((s) => s.value).filter((v): v is string => !!v);
    expect(new Set(values).size).toBe(values.length);
    expect(all.map((s) => s.name)).not.toContain('Moss');
  });

  it('counts a previous palette colour as the swatch that replaced it', async () => {
    const { swatchFor, sameColour, swatchName } = await import('./noteColors');
    expect(swatchFor('#dde7d4')?.name).toBe('Sage'); // Moss folded into Sage
    expect(swatchName('#DFE9DF')).toBe('Sage');
    expect(sameColour('#dde7d4', swatchFor('#dfe9df')?.value)).toBe(true);
    expect(sameColour('#ecd9da', '#d8e3ea')).toBe(false);
    expect(sameColour('#123456', '#123456')).toBe(true);
    expect(sameColour(null, null)).toBe(true);
    expect(swatchFor('#123456')).toBeNull();
  });
});
