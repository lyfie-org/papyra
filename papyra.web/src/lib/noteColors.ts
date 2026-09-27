// Premium note palette — muted, editorial tints that sit on the warm paper bg.
// `value` is the literal hex written into the note's YAML `color:` frontmatter
// (null clears it back to the default surface). Shared by the colour picker and
// the smart-collection rule builder, so a rule offers the colours a person can
// actually pick rather than asking them to type a hex code.
//
// Six hues spaced round the wheel (green, butter, peach, pink, violet, blue) at
// one lightness, so they differ by hue rather than by shade: the closest pair is
// ΔE ≈ 10 (the old palette had Sage/Moss at 4.8 and Clay/Sand at 5.1 — near
// twins). All hold ≥9.7:1 under dark ink, and ≥6.4:1 once dark mode mutes them.
export const NOTE_SWATCHES: { name: string; value: string | null }[] = [
  { name: 'Default', value: null },
  { name: 'Sage', value: '#d3e8d0' },
  { name: 'Sand', value: '#f1e4c7' },
  { name: 'Clay', value: '#f8d6c4' },
  { name: 'Rose', value: '#fbd3d9' },
  { name: 'Lilac', value: '#e0d9f5' },
  { name: 'Sky', value: '#c1e5f7' },
];

// Colours from the previous palette, as notes on disk still carry them. They
// keep rendering as written; for picking, naming and smart collections they
// count as the swatch that replaced them (Moss folded into Sage).
const LEGACY_SWATCHES: Record<string, string> = {
  '#dfe9df': 'Sage',
  '#dde7d4': 'Sage',
  '#ece3cf': 'Sand',
  '#ecdcd0': 'Clay',
  '#ecd9da': 'Rose',
  '#e2dcec': 'Lilac',
  '#d8e3ea': 'Sky',
};

/** The palette swatch a colour belongs to — current or legacy value — if any. */
export function swatchFor(value: string | null | undefined): { name: string; value: string | null } | null {
  if (!value) return null;
  const v = value.trim().toLowerCase();
  const current = NOTE_SWATCHES.find((s) => s.value?.toLowerCase() === v);
  if (current) return current;
  const legacy = LEGACY_SWATCHES[v];
  return legacy ? NOTE_SWATCHES.find((s) => s.name === legacy) ?? null : null;
}

/** Whether two colours are the same swatch (legacy values included), or equal. */
export function sameColour(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return !a && !b;
  const sa = swatchFor(a);
  const sb = swatchFor(b);
  if (sa && sb) return sa.name === sb.name;
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/** A colour's palette name, or null for one that came from elsewhere (an import). */
export function swatchName(value: string | null | undefined): string | null {
  return swatchFor(value)?.name ?? null;
}

// ── Ink for a coloured note ─────────────────────────────────────────────────────
// The palette above is all light pastels, but `color:` is free YAML — an import or
// a hand edit can set any colour, including a dark one. Pick the ink (and with it
// the caret, selection and floating chrome — see `.tint--light-ink` in tokens.css)
// from the colour the note is actually painted, so it reads on anything.

// Mirrors tokens.css: dark mode paints a tint as color-mix(tint 78%, --surface).
const DARK_SURFACE: RGB = [0x28, 0x23, 0x1e];
const DARK_TINT_STRENGTH = 0.78;
const DARK_INK: RGB = [0x3d, 0x2c, 0x1e]; // --tint-ink
const LIGHT_INK: RGB = [0xf0, 0xe6, 0xd3]; // .tint--light-ink --tint-ink

type RGB = [number, number, number];

function parseHex(value: string): RGB | null {
  const m = /^#([0-9a-f]{3,8})$/i.exec(value.trim());
  if (!m) return null;
  let hex = m[1];
  if (hex.length === 3 || hex.length === 4) hex = [...hex.slice(0, 3)].map((c) => c + c).join('');
  if (hex.length !== 6 && hex.length !== 8) return null;
  return [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16)) as RGB;
}

let probe: CanvasRenderingContext2D | null | undefined;
/** Any CSS colour (named, rgb(), hsl()…) → RGB, via the browser's own parser. */
function parseCss(value: string): RGB | null {
  const hex = parseHex(value);
  if (hex) return hex;
  if (probe === undefined) {
    try {
      probe = typeof document === 'undefined' ? null : document.createElement('canvas').getContext('2d');
    } catch {
      probe = null;
    }
  }
  if (!probe) return null;
  probe.fillStyle = '#010203';
  probe.fillStyle = value;
  const normalised = String(probe.fillStyle);
  if (normalised === '#010203' && value.trim().toLowerCase() !== '#010203') return null; // not a colour
  const fromHex = parseHex(normalised);
  if (fromHex) return fromHex;
  const rgb = /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i.exec(normalised);
  return rgb ? [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])] : null;
}

function luminance([r, g, b]: RGB): number {
  const f = (v: number) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

function contrast(a: RGB, b: RGB): number {
  const [x, y] = [luminance(a), luminance(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

function paintedRgb(color: string | null | undefined, theme: 'light' | 'dark'): RGB | null {
  if (!color) return null;
  const rgb = parseCss(color);
  if (!rgb) return null;
  return theme === 'dark'
    ? (rgb.map((v, i) => Math.round(v * DARK_TINT_STRENGTH + DARK_SURFACE[i] * (1 - DARK_TINT_STRENGTH))) as RGB)
    : rgb;
}

/**
 * Which ink a note painted `color` needs in `theme`: 'dark' (the default tint
 * ink) or 'light'. Whichever contrasts more with the painted colour wins; an
 * unparseable colour keeps the default.
 */
export function tintInk(color: string | null | undefined, theme: 'light' | 'dark'): 'dark' | 'light' {
  const painted = paintedRgb(color, theme);
  if (!painted) return 'dark';
  return contrast(painted, LIGHT_INK) > contrast(painted, DARK_INK) ? 'light' : 'dark';
}

/**
 * The classes that re-ink a coloured surface: ` tint--light-ink` for a dark
 * colour, plus ` tint--high-ink` when even the better of the two warm inks
 * falls under 4.5:1 (a mid-tone) — that one steps up to pure black or white.
 */
export function tintInkClass(color: string | null | undefined, theme: 'light' | 'dark'): string {
  const painted = paintedRgb(color, theme);
  if (!painted) return '';
  const best = Math.max(contrast(painted, LIGHT_INK), contrast(painted, DARK_INK));
  if (best >= 4.5) {
    return contrast(painted, LIGHT_INK) > contrast(painted, DARK_INK) ? ' tint--light-ink' : '';
  }
  // Pure ink: pick black or white on its own merits — near the middle the
  // winner can differ from the warm pair's.
  const white = contrast(painted, [255, 255, 255]) > contrast(painted, [0, 0, 0]);
  return `${white ? ' tint--light-ink' : ''} tint--high-ink`;
}
