// Premium note palette — muted, editorial tints that sit on the warm paper bg.
// `value` is the literal hex written into the note's YAML `color:` frontmatter
// (null clears it back to the default surface). Shared by the colour picker and
// the smart-collection rule builder, so a rule offers the colours a person can
// actually pick rather than asking them to type a hex code.
export const NOTE_SWATCHES: { name: string; value: string | null }[] = [
  { name: 'Default', value: null },
  { name: 'Sage', value: '#dfe9df' },
  { name: 'Clay', value: '#ecdcd0' },
  { name: 'Sand', value: '#ece3cf' },
  { name: 'Rose', value: '#ecd9da' },
  { name: 'Sky', value: '#d8e3ea' },
  { name: 'Lilac', value: '#e2dcec' },
  { name: 'Moss', value: '#dde7d4' },
];

/** A colour's palette name, or null for one that came from elsewhere (an import). */
export function swatchName(value: string | null | undefined): string | null {
  if (!value) return null;
  return NOTE_SWATCHES.find((s) => s.value?.toLowerCase() === value.toLowerCase())?.name ?? null;
}
