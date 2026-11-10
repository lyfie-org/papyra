import { useT } from '../i18n/store';
import type { Area } from '../lib/settingsAreas';
import './SettingsAreaSwitch.css';

const AREAS: Area[] = ['you', 'server'];

/**
 * Administrators only: choose between the settings that change things for you and the ones that change things for
 * everyone on this server. Two plain buttons; the pressed one is the area on screen (the page reads it from the
 * address, so a reload or a shared link lands in the same place). Everyone else never sees this.
 */
export default function SettingsAreaSwitch({ area, onChange }: { area: Area; onChange: (next: Area) => void }) {
  const t = useT();
  return (
    <div className="area-switch" role="group" aria-label={t('settings.area.label')}>
      {AREAS.map(a => (
        <button
          key={a}
          type="button"
          className={`area-switch__option${a === area ? ' is-active' : ''}`}
          aria-pressed={a === area}
          onClick={() => onChange(a)}
        >
          {t(a === 'server' ? 'settings.area.server' : 'settings.area.you')}
        </button>
      ))}
    </div>
  );
}
