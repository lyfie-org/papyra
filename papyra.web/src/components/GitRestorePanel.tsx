import { useState } from 'react';
import { CheckCircle2, Loader2, TriangleAlert } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { restoreFromGit, type BackupSummary } from '../hooks/useGitSync';
import { summaryLine } from '../lib/backupSummary';
import { MASKED_SECRET, NO_AUTOFILL } from '../lib/autofill';
import { normaliseRepoUrl, repoLabel } from '../lib/gitUrl';
import './GitRestorePanel.css';

/**
 * Pull a GitHub backup back into this account — readable or encrypted, the
 * current layout or an older Papyra's. Used in Settings → Backup and in the
 * first-run setup. `confirmReplace` asks for an explicit tick first, because a
 * restore replaces every note in the account.
 */
export default function GitRestorePanel({
  onRestored, accountPassword, confirmReplace = true,
}: {
  onRestored?: (restored: number, summary: BackupSummary) => void;
  /** Re-seal an encrypted backup under this password (setup knows it). */
  accountPassword?: string;
  confirmReplace?: boolean;
}) {
  const queryClient = useQueryClient();
  const [repoInput, setRepoInput] = useState('');
  const [branch, setBranch] = useState('main');
  const [token, setToken] = useState('');
  const [password, setPassword] = useState('');
  const [needsPassword, setNeedsPassword] = useState(false);
  const [keepSyncing, setKeepSyncing] = useState(true);
  const [understood, setUnderstood] = useState(!confirmReplace);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ restored: number; summary: BackupSummary } | null>(null);

  const repoUrl = normaliseRepoUrl(repoInput);
  const ready = !!repoUrl && !!token.trim() && understood && (!needsPassword || !!password);

  async function restore() {
    if (!repoUrl) return;
    setBusy(true);
    setError(null);
    try {
      const res = await restoreFromGit({
        remoteUrl: repoUrl, branch: branch.trim() || 'main', token: token.trim(),
        password: password || undefined, keepSyncing, accountPassword,
      });
      if (!res.ok) {
        if (res.code === 'password_required' || res.code === 'password_wrong') setNeedsPassword(true);
        setError(res.error);
        return;
      }
      setDone({ restored: res.restored, summary: res.summary });
      await queryClient.invalidateQueries();
      onRestored?.(res.restored, res.summary);
    } catch {
      setError('Couldn’t reach Papyra’s server.');
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <p className="git-restore__good" role="status">
        <CheckCircle2 size={16} aria-hidden="true" /> Restored {summaryLine(done.summary)}
        {keepSyncing ? ' — and backing up to the same repository from now on.' : '.'}
      </p>
    );
  }

  return (
    <div className="git-restore">
      <label className="git-restore__field">
        Repository address
        <input
          type="url" value={repoInput} {...NO_AUTOFILL}
          placeholder="https://github.com/your-name/papyra-notes"
          onChange={e => { setRepoInput(e.target.value); setError(null); }}
        />
        {repoUrl && <span className="git-restore__hint">{repoLabel(repoUrl)}</span>}
      </label>
      <div className="git-restore__row">
        <label className="git-restore__field">
          Branch
          <input value={branch} {...NO_AUTOFILL} onChange={e => setBranch(e.target.value)} />
        </label>
        <label className="git-restore__field git-restore__field--grow">
          Access token
          <input {...MASKED_SECRET} value={token} placeholder="github_pat_…" onChange={e => { setToken(e.target.value); setError(null); }} />
        </label>
      </div>
      <label className="git-restore__field">
        Backup password {needsPassword ? '' : <span className="git-restore__hint">(only for encrypted backups)</span>}
        <input
          type="password" value={password} autoComplete="off"
          placeholder="The Papyra password you had when the backup was made"
          onChange={e => { setPassword(e.target.value); setError(null); }}
        />
      </label>
      <label className="git-restore__check">
        <input type="checkbox" checked={keepSyncing} onChange={e => setKeepSyncing(e.target.checked)} />
        Keep backing up to this repository afterwards
      </label>
      {confirmReplace && (
        <label className="git-restore__check">
          <input type="checkbox" checked={understood} onChange={e => setUnderstood(e.target.checked)} />
          I understand this <strong>replaces</strong> every note, attachment and setting in this account with the backup.
        </label>
      )}
      {error && <p className="git-restore__bad" role="alert"><TriangleAlert size={15} aria-hidden="true" /> {error}</p>}
      <div>
        <button type="button" className="settings__btn" disabled={!ready || busy} onClick={() => void restore()}>
          {busy ? <><Loader2 size={15} className="git-spin" aria-hidden="true" /> Restoring…</> : 'Restore from GitHub'}
        </button>
      </div>
    </div>
  );
}
