import { Check, Minus } from '@phosphor-icons/react';
import { NOTE_THEMES, NOTE_ART, resolveTheme } from '../lib/noteThemes';
import './ThemeChooser.css';

interface ThemeChooserProps {
  currentTheme: string;
  onSelect: (theme: string) => void;
}

export default function ThemeChooser({ currentTheme, onSelect }: ThemeChooserProps) {
  const { colorTheme, artTheme } = resolveTheme(currentTheme);

  const handleColorSelect = (newColor: string) => {
    onSelect(`${newColor}:${artTheme}`);
  };

  const handleArtSelect = (newArt: string) => {
    onSelect(`${colorTheme}:${newArt}`);
  };

  return (
    <div className="theme-chooser" role="group" aria-label="Note theme and art">
      <div className="theme-chooser__row" role="listbox" aria-label="Note colour">
        {NOTE_THEMES.map(({ name, label }) => {
          const isActive = name === colorTheme;
          return (
            <button
              key={name}
              className="theme-chooser__swatch"
              data-swatch={name}
              role="option"
              aria-selected={isActive}
              aria-label={label}
              title={label}
              onClick={() => handleColorSelect(name)}
            >
              {name === 'default' && !isActive && <Minus size={10} className="theme-chooser__icon-slash" aria-hidden="true" />}
              {isActive && <Check size={10} className="theme-chooser__check" aria-hidden="true" />}
            </button>
          );
        })}
      </div>
      <div className="theme-chooser__divider" />
      <div className="theme-chooser__row theme-chooser__row--art" role="listbox" aria-label="Note art">
        {NOTE_ART.map(({ name, label }) => {
          const isActive = name === artTheme;
          return (
            <button
              key={name}
              className="theme-chooser__swatch theme-chooser__swatch--art"
              data-art={name}
              role="option"
              aria-selected={isActive}
              aria-label={label}
              title={label}
              onClick={() => handleArtSelect(name)}
            >
              {name === 'none' && !isActive && <Minus size={10} className="theme-chooser__icon-slash" aria-hidden="true" />}
              {isActive && <Check size={10} className="theme-chooser__check" aria-hidden="true" />}
            </button>
          );
        })}
      </div>
    </div>
  );
}
