import { useState } from 'react';

/**
 * The one editor behind every "Rename" — devices, authenticators, passkeys, API
 * keys. PUTs `{ name }` to `url` and folds back on success.
 */
export default function RenameForm({ url, current, placeholder, onDone, onCancel }: {
  url: string;
  current: string;
  placeholder?: string;
  onDone: () => void | Promise<void>;
  onCancel: () => void;
}) {
  const [name, setName] = useState(current);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  return (
    <form className="settings__form" onSubmit={async e => {
      e.preventDefault();
      if (name.trim() === current) { onCancel(); return; }
      setBusy(true);
      const res = await fetch(url, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) })
        .catch(() => null);
      const data = await res?.json().catch(() => null) as { error?: string } | null;
      setBusy(false);
      if (res?.ok) await onDone(); else setError(data?.error ?? 'Couldn’t rename it.');
    }}>
      <label className="settings__field">Name
        <input value={name} maxLength={60} placeholder={placeholder} autoFocus
          onChange={e => { setName(e.target.value); setError(null); }} />
      </label>
      {error && <p className="settings__error" role="alert">{error}</p>}
      <div className="settings__form-actions">
        <button type="submit" className="settings__btn" disabled={busy || !name.trim()}>{busy ? 'Saving…' : 'Save'}</button>
        <button type="button" className="settings__btn settings__btn--quiet" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}
