import { useRef, useState } from 'react';
import { CheckCircle2, Download, GitBranch, TriangleAlert, Upload } from 'lucide-react';
import {
  applyInstanceRestore, restoreForm, stageInstanceRestore, useInstanceBackup, useRunInstanceBackup, useSaveInstanceBackup,
  type InstanceBackupStatus, type InstanceRestoreSummary, type RestoreSource,
} from '../hooks/useInstanceBackup';
import { useConfirm } from '../lib/confirmContext';
import { MASKED_SECRET, NO_AUTOFILL } from '../lib/autofill';
import { normaliseRepoUrl } from '../lib/gitUrl';
import BusyButton from './BusyButton';
import LoadingBar from './LoadingBar';
import RestartWatch from './RestartWatch';
import SettingRow, { SettingGroup } from './SettingRow';
import { useT } from '../i18n/store';

// Server settings → Server backup (administrators). Everything in papyra.db that no
// per-account backup carries (accounts, passkeys, sharing, API keys, the mail and
// SSO settings) plus the key ring that seals part of it, encrypted under a
// passphrase. Notes are not in it: those are the files, or each account's backup.

function when(iso: string | null): string {
  return iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : 'never';
}

function size(bytes: number): string {
  return bytes < 1_048_576 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1_048_576).toFixed(1)} MB`;
}

export default function InstanceBackupPanel() {
  const t = useT();
  const { data, isLoading, isError } = useInstanceBackup();

  if (isLoading) return <div className="settings__panel"><LoadingBar label="Loading settings" /></div>;
  if (isError || !data) return <div className="settings__panel"><p className="settings__error">{t('settings.serverBackup.loadError')}</p></div>;

  return (
    <div className="settings__panel">
      <StatusGroup status={data} />
      <DestinationsGroup status={data} />
      <RestoreGroup />
    </div>
  );
}

function StatusGroup({ status }: { status: InstanceBackupStatus }) {
  const t = useT();
  const save = useSaveInstanceBackup();
  const run = useRunInstanceBackup();
  const [passphrase, setPassphrase] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);

  const configured = status.local || status.gitRemote !== '';

  async function setNewPassphrase(close: () => void) {
    setError(null);
    try {
      await save.mutateAsync({
        passphrase, local: status.local, keep: status.keep,
        gitRemote: status.gitRemote, gitBranch: status.gitBranch,
      });
      setPassphrase('');
      close();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function download() {
    setDownloading(true);
    setError(null);
    try {
      const res = await fetch('/api/instance-backup/download');
      if (!res.ok) throw new Error(((await res.json().catch(() => null)) as { error?: string } | null)?.error ?? 'The download failed.');
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement('a');
      a.href = url;
      a.download = /filename="?([^";]+)"?/.exec(res.headers.get('Content-Disposition') ?? '')?.[1] ?? 'papyra-instance.papyra-instance';
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setDownloading(false);
    }
  }

  return (
    <SettingGroup
      title={t('settings.serverBackup.title')}
      id="instance-backup"
      footer={(
        <>
          <p className="settings__hint">
            Accounts, passkeys, sharing, API keys and the email and SSO settings, with the keys that seal them. Notes
            are not in it: those are your files, or each person’s own backup.
          </p>
          <div className="settings__form-actions">
            <BusyButton
              type="button" className="settings__btn" disabled={!status.passphraseSet || !configured}
              busy={run.isPending} busyLabel="Backing up…" onClick={() => run.mutate()}
            >
              Back up now
            </BusyButton>
            <BusyButton
              type="button" className="settings__btn settings__btn--quiet" disabled={!status.passphraseSet}
              busy={downloading} busyLabel="Preparing…" onClick={() => void download()}
            >
              <Download size={14} aria-hidden="true" /> Download
            </BusyButton>
          </div>
          {run.isError && <p className="settings__error">{(run.error as Error).message}</p>}
          {error && <p className="settings__error">{error}</p>}
        </>
      )}
    >
      <SettingRow
        label="Backup passphrase"
        value={status.passphraseSet ? 'Set' : undefined}
        empty="Not set"
        action={status.passphraseSet ? 'Change' : 'Set'}
        hint="Choose one before anything is backed up. It opens every server backup and can’t be recovered: keep it somewhere other than this server."
      >
        {close => (
          <form className="settings__form" onSubmit={e => { e.preventDefault(); void setNewPassphrase(close); }}>
            <label className="settings__field">New passphrase
              <input
                {...MASKED_SECRET} value={passphrase} minLength={12} required autoFocus
                placeholder="At least 12 characters" onChange={e => setPassphrase(e.target.value)}
              />
            </label>
            <p className="settings__hint">
              Older backups still open with the passphrase they were made with, so keep the old one until you no longer need them.
            </p>
            <div className="settings__form-actions">
              <BusyButton type="submit" className="settings__btn" busy={save.isPending} busyLabel="Saving…">Save</BusyButton>
              <button type="button" className="settings__btn settings__btn--quiet" onClick={() => { setPassphrase(''); setError(null); close(); }}>
                Cancel
              </button>
            </div>
          </form>
        )}
      </SettingRow>
      <SettingRow
        label="Last backup"
        value={status.lastLocalUtc || status.gitRemote ? `${status.local ? `Local ${when(status.lastLocalUtc)}` : ''}${status.local && status.gitRemote ? ' · ' : ''}${status.gitRemote ? `Git ${when(status.lastGitUtc)}` : ''}` : undefined}
        empty="Never"
      />
      {status.lastError && (
        <SettingRow label="Last problem" value={<span className="settings__error">{status.lastError}</span>} />
      )}
    </SettingGroup>
  );
}

function DestinationsGroup({ status }: { status: InstanceBackupStatus }) {
  const save = useSaveInstanceBackup();
  const [keep, setKeep] = useState(String(status.keep));
  const [remote, setRemote] = useState(status.gitRemote);
  const [branch, setBranch] = useState(status.gitBranch || 'main');
  const [token, setToken] = useState('');
  const [error, setError] = useState<string | null>(null);

  async function write(next: { local: boolean; keep: number; gitRemote: string; gitBranch: string; gitToken?: string }, close?: () => void) {
    setError(null);
    try {
      await save.mutateAsync(next);
      setToken('');
      close?.();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const repo = normaliseRepoUrl(remote) ?? remote.trim();

  return (
    <SettingGroup title="Where it goes" id="instance-destinations" footer={error ? <p className="settings__error">{error}</p> : undefined}>
      <SettingRow
        label="Copies on this server"
        value={status.local
          ? `On, keeping the newest ${status.keep}${status.copies.length ? ` (${status.copies.length} now, ${size(status.copies.reduce((n, c) => n + c.bytes, 0))})` : ''}`
          : 'Off'}
        action="Change"
        hint="A daily encrypted file in .papyra/instance-backups. It survives a corrupted database, not a lost disk."
      >
        {close => (
          <form className="settings__form" onSubmit={e => {
            e.preventDefault();
            void write({ local: true, keep: Number(keep) || 7, gitRemote: status.gitRemote, gitBranch: status.gitBranch }, close);
          }}>
            <label className="settings__field">Keep the newest
              <input type="number" min={1} max={60} value={keep} onChange={e => setKeep(e.target.value)} />
            </label>
            <div className="settings__form-actions">
              <BusyButton type="submit" className="settings__btn" busy={save.isPending} busyLabel="Saving…">
                {status.local ? 'Save' : 'Turn on'}
              </BusyButton>
              {status.local && (
                <BusyButton
                  type="button" className="settings__btn settings__btn--quiet" busy={save.isPending}
                  onClick={() => write({ local: false, keep: status.keep, gitRemote: status.gitRemote, gitBranch: status.gitBranch }, close)}
                >
                  Turn off
                </BusyButton>
              )}
              <button type="button" className="settings__btn settings__btn--quiet" onClick={close}>Cancel</button>
            </div>
          </form>
        )}
      </SettingRow>

      <SettingRow
        label={<><GitBranch size={14} aria-hidden="true" /> Git repository</>}
        value={status.gitRemote ? `${status.gitRemote} (${status.gitBranch || 'main'})` : 'Off'}
        action={status.gitRemote ? 'Change' : 'Set up'}
        hint="Pushes the same encrypted file once a day. Use a private repository of its own, not the one that holds your notes."
      >
        {close => (
          <form className="settings__form" onSubmit={e => {
            e.preventDefault();
            void write({ local: status.local, keep: status.keep, gitRemote: repo, gitBranch: branch.trim() || 'main', gitToken: token.trim() || undefined }, close);
          }}>
            <label className="settings__field">Repository address
              <input type="url" {...NO_AUTOFILL} value={remote} placeholder="https://github.com/you/papyra-instance" onChange={e => setRemote(e.target.value)} />
            </label>
            <label className="settings__field">Branch
              <input type="text" {...NO_AUTOFILL} value={branch} onChange={e => setBranch(e.target.value)} />
            </label>
            <label className="settings__field">Access token {status.gitTokenSet && <span className="settings__hint">(one is saved; leave blank to keep it)</span>}
              <input {...MASKED_SECRET} value={token} placeholder={status.gitTokenSet ? '••••••••' : 'github_pat_…'} onChange={e => setToken(e.target.value)} />
            </label>
            <p className="settings__hint">A token that can write to this repository: Contents, read and write.</p>
            <div className="settings__form-actions">
              <BusyButton type="submit" className="settings__btn" busy={save.isPending} busyLabel="Checking…">Save</BusyButton>
              {status.gitRemote && (
                <BusyButton
                  type="button" className="settings__btn settings__btn--quiet" busy={save.isPending}
                  onClick={() => write({ local: status.local, keep: status.keep, gitRemote: '', gitBranch: '' }, close)}
                >
                  Turn off
                </BusyButton>
              )}
              <button type="button" className="settings__btn settings__btn--quiet" onClick={close}>Cancel</button>
            </div>
          </form>
        )}
      </SettingRow>

      {status.copies.length > 0 && (
        <SettingRow
          label="Copies kept here"
          value={status.copies.map(c => <span key={c.name} style={{ display: 'block' }}>{when(c.modifiedUtc)} · {size(c.bytes)}</span>)}
        />
      )}
    </SettingGroup>
  );
}

function RestoreGroup() {
  const t = useT();
  const confirm = useConfirm();
  const [kind, setKind] = useState<'file' | 'git'>('file');
  const [file, setFile] = useState<File | null>(null);
  const [repo, setRepo] = useState('');
  const [branch, setBranch] = useState('main');
  const [token, setToken] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [staged, setStaged] = useState<InstanceRestoreSummary | null>(null);
  const [restarting, setRestarting] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const repoUrl = normaliseRepoUrl(repo);
  const ready = !!passphrase && !!password && (kind === 'file' ? !!file : !!repoUrl);

  async function check() {
    setBusy(true);
    setError(null);
    try {
      const source: RestoreSource = kind === 'file'
        ? { kind, file: file! }
        : { kind, remoteUrl: repoUrl ?? '', branch: branch.trim() || 'main', token: token.trim() };
      setStaged(await stageInstanceRestore(restoreForm(source, passphrase, password)));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function replace() {
    if (!staged) return;
    const ok = await confirm({
      title: 'Replace every account and setting?',
      body: `This server’s ${staged.users === 1 ? 'account' : 'accounts'}, passkeys, sharing, API keys and settings are replaced with the backup’s ${staged.users} ${staged.users === 1 ? 'account' : 'accounts'}, and Papyra restarts. Everyone is signed out if the backup’s keys differ. What is replaced is kept in .papyra/replaced-by-restore-*.`,
      confirmLabel: 'Replace and restart',
      destructive: true,
    });
    if (!ok) return;
    setBusy(true);
    setError(null);
    try {
      await applyInstanceRestore(staged.restoreId);
      setRestarting(true);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <SettingGroup
      title={t('settings.serverBackup.restore')}
      id="instance-restore"
      footer={restarting ? <RestartWatch /> : undefined}
    >
      <SettingRow
        label="Restore"
        value="Replace accounts and settings"
        action="Restore…"
        hint="For a new or damaged install. Notes come back from your files or each person’s own backup."
      >
        {close => (
          <form className="settings__form" onSubmit={e => { e.preventDefault(); if (ready && !staged) void check(); }}>
            {!staged && (
              <>
                <div className="settings__form-actions" role="group" aria-label="Where the backup is">
                  <button type="button" aria-pressed={kind === 'file'} className={`settings__btn${kind === 'file' ? '' : ' settings__btn--ghost'}`} onClick={() => setKind('file')}>Backup file</button>
                  <button type="button" aria-pressed={kind === 'git'} className={`settings__btn${kind === 'git' ? '' : ' settings__btn--ghost'}`} onClick={() => setKind('git')}>Git repository</button>
                </div>
                {kind === 'file' ? (
                  <div className="settings__field">Backup file (.papyra-instance)
                    <button type="button" className="settings__btn settings__btn--quiet" onClick={() => fileRef.current?.click()}>
                      <Upload size={14} aria-hidden="true" /> {file ? file.name : 'Choose file…'}
                    </button>
                    <input ref={fileRef} type="file" accept=".papyra-instance" hidden onChange={e => setFile(e.target.files?.[0] ?? null)} />
                  </div>
                ) : (
                  <>
                    <label className="settings__field">Repository address
                      <input type="url" {...NO_AUTOFILL} value={repo} onChange={e => setRepo(e.target.value)} placeholder="https://github.com/you/papyra-instance" />
                    </label>
                    <label className="settings__field">Branch
                      <input type="text" {...NO_AUTOFILL} value={branch} onChange={e => setBranch(e.target.value)} />
                    </label>
                    <label className="settings__field">Access token
                      <input {...MASKED_SECRET} value={token} onChange={e => setToken(e.target.value)} placeholder="github_pat_…" />
                    </label>
                  </>
                )}
                <label className="settings__field">Backup passphrase
                  <input {...MASKED_SECRET} value={passphrase} onChange={e => setPassphrase(e.target.value)} />
                </label>
                <label className="settings__field">Your password
                  <input type="password" autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)} />
                </label>
              </>
            )}
            {staged && (
              <div className="settings__callout" role="note">
                <CheckCircle2 size={18} aria-hidden="true" />
                <div>
                  <strong>Backup opened: {staged.users} {staged.users === 1 ? 'account' : 'accounts'}.</strong>
                  <p>{staged.createdUtc ? `Made ${when(staged.createdUtc)}. ` : ''}Nothing has changed yet.</p>
                </div>
              </div>
            )}
            {error && <p className="settings__error" role="alert"><TriangleAlert size={14} aria-hidden="true" /> {error}</p>}
            {!restarting && (
              <div className="settings__form-actions">
                {staged ? (
                  <BusyButton type="button" className="settings__btn" busy={busy} busyLabel="Restoring…" onClick={() => void replace()}>
                    Replace and restart
                  </BusyButton>
                ) : (
                  <BusyButton type="submit" className="settings__btn" disabled={!ready} busy={busy} busyLabel="Opening backup…">
                    Open backup
                  </BusyButton>
                )}
                <button type="button" className="settings__btn settings__btn--quiet" onClick={() => { setStaged(null); setError(null); close(); }}>
                  Cancel
                </button>
              </div>
            )}
          </form>
        )}
      </SettingRow>
    </SettingGroup>
  );
}
