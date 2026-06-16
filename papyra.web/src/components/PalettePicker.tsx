import './PalettePicker.css';

// Premium note palette — muted, editorial tints that sit on the warm paper bg.
// `value` is the literal hex written into the note's YAML `color:` frontmatter
// (null clears it back to the default surface).
const SWATCHES: { name: string; value: string | null }[] = [
  { name: 'Default', value: null },
  { name: 'Sage', value: '#dfe9df' },
  { name: 'Clay', value: '#ecdcd0' },
  { name: 'Sand', value: '#ece3cf' },
  { name: 'Rose', value: '#ecd9da' },
  { name: 'Sky', value: '#d8e3ea' },
  { name: 'Lilac', value: '#e2dcec' },
  { name: 'Moss', value: '#dde7d4' },
];

export default function PalettePicker({
  active,
  onPick,
}: {
  active: string | null;
  onPick: (color: string | null) => void;
}) {
  return (
    <div className="palette-picker" role="menu" aria-label="Note color">
      {SWATCHES.map((s) => {
        const isActive = (active ?? null) === s.value;
        const noneClass = s.value === null ? ' palette-picker__swatch--none' : '';
        return (
          <button
            key={s.name}
            type="button"
            role="menuitemradio"
            aria-checked={isActive}
            aria-label={s.name}
            title={s.name}
            className={`palette-picker__swatch${isActive ? ' is-active' : ''}${noneClass}`}
            style={s.value ? { background: s.value } : undefined}
            onClick={() => onPick(s.value)}
          />
        );
      })}
    </div>
  );
}
