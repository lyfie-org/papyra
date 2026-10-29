import { useState } from 'react';
import { useConfirm } from '../../lib/confirmContext';
import { useToast } from '../../lib/toastContext';
import { useDeleteTemplate, useJournalTemplates, useSaveJournalPrefs, useSaveTemplate } from '../../hooks/useJournal';
import { TEMPLATE_TOKENS } from '../../lib/journalTemplates';
import BusyButton from '../BusyButton';
import SettingRow, { SettingGroup } from '../SettingRow';
import type { JournalTemplate } from '../../types/journal';
import './JournalTemplatesGroup.css';

const firstLine = (body: string) => body.split('\n').map((l) => l.replace(/^[#>\-*\s]+/, '').trim()).find(Boolean) ?? 'Empty page';

/** The form a template is written in: a name (new ones only) and its text. */
function Editor({ template, isDefault, onSave, onDelete, onDefault, close }: {
  template?: JournalTemplate;
  isDefault?: boolean;
  onSave: (name: string, body: string) => Promise<boolean>;
  onDelete?: () => Promise<void>;
  onDefault?: (on: boolean) => Promise<void>;
  close: () => void;
}) {
  const [name, setName] = useState(template?.name ?? '');
  const [body, setBody] = useState(template?.body ?? '');
  return (
    <div className="journal-template-editor">
      {!template && (
        <label className="settings__field">
          Name
          <input value={name} maxLength={60} onChange={(e) => setName(e.target.value)} placeholder="Evening review" />
        </label>
      )}
      <label className="settings__field">
        Page
        <textarea
          className="journal-template-editor__text" rows={9} value={body} onChange={(e) => setBody(e.target.value)}
          placeholder={'## {{weekday}}\n\nOne good thing:\n'}
        />
      </label>
      <p className="settings__hint">Fills in {TEMPLATE_TOKENS.join(', ')}.</p>
      <div className="settings__form-actions">
        <BusyButton
          type="button" className="settings__btn" busyLabel="Saving…" disabled={!name.trim()}
          onClick={async () => { if (await onSave(name, body)) close(); }}
        >Save</BusyButton>
        {template && onDefault && (
          <BusyButton type="button" className="settings__btn settings__btn--quiet" busyLabel="Saving…" onClick={async () => { await onDefault(!isDefault); close(); }}>
            {isDefault ? 'Not the default' : 'Make the default'}
          </BusyButton>
        )}
        {template && onDelete && (
          <BusyButton type="button" className="settings__btn settings__btn--quiet" busyLabel="Removing…" onClick={async () => { await onDelete(); close(); }}>Remove</BusyButton>
        )}
        <button type="button" className="settings__btn settings__btn--quiet" onClick={close}>Cancel</button>
      </div>
    </div>
  );
}

/** Settings → Journal → Templates: the pages a blank day can start from. */
export default function JournalTemplatesGroup() {
  const templates = useJournalTemplates();
  const save = useSaveTemplate();
  const remove = useDeleteTemplate();
  const prefs = useSaveJournalPrefs();
  const confirm = useConfirm();
  const { toast } = useToast();

  const list = templates.data?.templates ?? [];
  const current = templates.data?.defaultTemplate ?? null;

  const saveOne = async (name: string, body: string): Promise<boolean> => {
    try {
      await save.mutateAsync({ name, body });
      return true;
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Couldn’t save that template.');
      return false;
    }
  };

  return (
    <SettingGroup title="Templates" id="journal-templates">
      {list.map((t) => (
        <SettingRow key={t.name} label={t.name} value={firstLine(t.body)} hint={current === t.name ? 'The first one offered on a blank day.' : undefined}>
          {(close) => (
            <Editor
              template={t}
              isDefault={current === t.name}
              close={close}
              onSave={(_, body) => saveOne(t.name, body)}
              onDefault={async (on) => {
                try { await prefs.mutateAsync(on ? { defaultTemplate: t.name } : { clearDefaultTemplate: true }); }
                catch (error) { toast(error instanceof Error ? error.message : 'Couldn’t change the default.'); }
              }}
              onDelete={async () => {
                if (!(await confirm({ title: `Remove “${t.name}”?`, body: 'Days already written from it are not changed.', confirmLabel: 'Remove', destructive: true }))) return;
                try { await remove.mutateAsync(t.name); } catch (error) { toast(error instanceof Error ? error.message : 'Couldn’t remove it.'); }
              }}
            />
          )}
        </SettingRow>
      ))}
      <SettingRow label="New template" value={list.length === 0 ? 'A page to start a day from' : undefined} action="Add…">
        {(close) => <Editor close={close} onSave={saveOne} />}
      </SettingRow>
    </SettingGroup>
  );
}
