import { NOTE_SWATCHES as SWATCHES } from '../lib/noteColors';
import './PalettePicker.css';

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
