import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useJournalPrefs, useSaveJournalPrefs, JOURNAL_KEY } from '../../hooks/useJournal';
import { lockAllEntries } from '../../lib/journalApi';
import { dayStartLabel } from '../../lib/journalDay';
import { track } from '../../lib/progress';
import { useConfirm } from '../../lib/confirmContext';
import { useToast } from '../../lib/toastContext';
import BusyButton from '../BusyButton';
import LoadingBar from '../LoadingBar';
import SettingRow, { SettingGroup } from '../SettingRow';
import JournalTemplatesGroup from './JournalTemplatesGroup';
import type { JournalPrefsPatch } from '../../types/journal';

const HOURS = [0, 1, 2, 3, 4, 5];

function Switch({ label, hint, checked, disabled, onChange }: {
  label: string; hint?: string; checked: boolean; disabled?: boolean; onChange: (on: boolean) => void;
}) {
  return (
    <div className="setting-row">
      <div className="setting-row__line">
        <label className="settings__field settings__field--inline">
          <input type="checkbox" role="switch" className="switch" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
          <span className="setting-row__text">
            <span className="setting-row__label">{label}</span>
            {hint && <span className="setting-row__hint">{hint}</span>}
          </span>
        </label>
      </div>
    </div>
  );
}

/** Settings → Journal: when the day turns over, how it reads, and who may read it. */
export default function JournalSettingsPanel() {
  const prefs = useJournalPrefs();
  const save = useSaveJournalPrefs();
  const confirm = useConfirm();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [hour, setHour] = useState<number | null>(null);
  const [clock, setClock] = useState<string | null>(null);

  if (prefs.isPending) return <div className="settings__panel"><LoadingBar label="Loading" /></div>;
  if (!prefs.data) return <div className="settings__panel"><p className="settings__error" role="alert">Couldn’t load your journal settings.</p></div>;

  const { settings, pinSet } = prefs.data;
  const change = (patch: JournalPrefsPatch) =>
    save.mutateAsync(patch).catch((error: unknown) => {
      toast(error instanceof Error ? error.message : 'Couldn’t save that.');
    });

  async function lockAll() {
    if (!(await confirm({
      title: 'Lock every day of your journal?',
      body: 'Each day is scrambled on disk and opens with your vault PIN. Moods and the calendar keep working.',
      confirmLabel: 'Lock them all',
    }))) return;
    try {
      const { locked } = await track(lockAllEntries(), 'Locking your journal');
      void queryClient.invalidateQueries({ queryKey: JOURNAL_KEY });
      toast(locked === 0 ? 'Every day was already locked.' : `Locked ${locked} ${locked === 1 ? 'day' : 'days'}.`);
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Couldn’t lock the journal.');
    }
  }

  return (
    <div className="settings__panel">
      <SettingGroup title="The day" id="journal-day">
        <SettingRow
          label="A new day starts at"
          value={dayStartLabel(settings.dayStartsAt)}
          hint="Writing before then still belongs to the day before."
        >
          {(close) => (
            <>
              <select
                className="settings__select" aria-label="A new day starts at"
                value={hour ?? settings.dayStartsAt} onChange={(e) => setHour(Number(e.target.value))}
              >
                {HOURS.map((h) => <option key={h} value={h}>{dayStartLabel(h)}</option>)}
              </select>
              <div className="settings__form-actions">
                <BusyButton
                  type="button" className="settings__btn" busyLabel="Saving…"
                  onClick={async () => { await change({ dayStartsAt: hour ?? settings.dayStartsAt }); setHour(null); close(); }}
                >Save</BusyButton>
                <button type="button" className="settings__btn settings__btn--quiet" onClick={() => { setHour(null); close(); }}>Cancel</button>
              </div>
            </>
          )}
        </SettingRow>
        <Switch label="Writing prompts" hint="A line of encouragement on an empty page." checked={settings.promptsOn} onChange={(on) => void change({ promptsOn: on })} />
        <Switch label="Hide the streak" hint="Keeps the totals; the count goes away." checked={settings.hideStreak} onChange={(on) => void change({ hideStreak: on })} />
      </SettingGroup>

      <JournalTemplatesGroup />

      <SettingGroup title="Reminder" id="journal-reminder">
        <Switch
          label="Remind me by email" checked={settings.reminderOn}
          hint="Once a day, only if that day is still blank. Never says what you wrote."
          onChange={(on) => void change({ reminderOn: on, ...(on && !settings.reminderTime ? { reminderTime: '21:00' } : {}) })}
        />
        {settings.reminderOn && (
          <SettingRow label="Send it at" value={settings.reminderTime ?? '21:00'}>
            {(close) => (
              <>
                <input
                  type="time" className="settings__select" aria-label="Send it at"
                  defaultValue={settings.reminderTime ?? '21:00'}
                  onChange={(e) => setClock(e.target.value)}
                />
                <div className="settings__form-actions">
                  <BusyButton
                    type="button" className="settings__btn" busyLabel="Saving…"
                    onClick={async () => { if (clock) await change({ reminderTime: clock }); setClock(null); close(); }}
                  >Save</BusyButton>
                  <button type="button" className="settings__btn settings__btn--quiet" onClick={() => { setClock(null); close(); }}>Cancel</button>
                </div>
              </>
            )}
          </SettingRow>
        )}
      </SettingGroup>

      <SettingGroup
        title="Locking"
        id="journal-locking"
        footer="Locking scrambles a day on disk, so the folder, a Git remote and backups hold only scrambled text. Papyra keeps the key."
      >
        <Switch
          label="Lock new days" checked={settings.lockNewEntries} disabled={!pinSet && !settings.lockNewEntries}
          hint={pinSet ? undefined : 'Set a vault PIN in Security first.'}
          onChange={(on) => void change({ lockNewEntries: on })}
        />
        <SettingRow label="Lock every day" value="Seal what you’ve already written" action="Lock all…" actionDisabled={!pinSet}>
          {(close) => (
            <div className="settings__form-actions">
              <BusyButton type="button" className="settings__btn" busyLabel="Locking…" onClick={async () => { await lockAll(); close(); }}>
                Lock all days
              </BusyButton>
              <button type="button" className="settings__btn settings__btn--quiet" onClick={close}>Cancel</button>
            </div>
          )}
        </SettingRow>
      </SettingGroup>
    </div>
  );
}
