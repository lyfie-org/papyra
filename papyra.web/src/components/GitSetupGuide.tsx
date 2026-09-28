import { useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  ArrowLeft, ArrowRight, Check, CheckCircle2, ExternalLink, GitBranch, Loader2, RefreshCw, TriangleAlert, X,
} from 'lucide-react';
import { useDialogFocus } from '../hooks/useDialogFocus';
import {
  probeGitRemote, useGitConfig, useRunGitSync, useSaveGitConfig, type GitProbe,
} from '../hooks/useGitSync';
import { MASKED_SECRET, NO_AUTOFILL } from '../lib/autofill';
import './GitSetupGuide.css';

const REPO_NAME = 'papyra-notes';
const NEW_REPO_URL =
  `https://github.com/new?name=${REPO_NAME}&visibility=private&description=${encodeURIComponent('Backup of my Papyra notes')}`;
// Fine-grained: the token can only touch the one repository it's given.
const NEW_TOKEN_URL = 'https://github.com/settings/personal-access-tokens/new';
// Classic, pre-filled: simpler, but reaches every repository the account can.
const CLASSIC_TOKEN_URL =
  `https://github.com/settings/tokens/new?scopes=repo&description=${encodeURIComponent('Papyra backup')}`;

import { normaliseRepoUrl, repoLabel } from '../lib/gitUrl';

function when(iso: string | null): string {
  if (!iso) return 'Not yet';
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

/**
 * Settings → Backup's main surface. Before anything is set up it's one card with
 * one button, which opens a step-by-step guide that walks someone who has never
 * used GitHub from "no account" to a first backup. Once set up it's a status
 * card: where the notes go, when they last went, and "Back up now".
 */
export default function GitSetupGuide() {
  const { data } = useGitConfig();
  const run = useRunGitSync();
  const save = useSaveGitConfig();
  const [guideOpen, setGuideOpen] = useState(false);

  const configured = Boolean(data?.remoteUrl);
  const failing = Boolean(data?.conflict || data?.lastError);

  return (
    <>
      {!configured ? (
        <div className="git-card git-card--start">
          <span className="git-card__icon" aria-hidden="true"><GitBranch size={22} /></span>
          <div className="git-card__body">
            <p className="git-card__title">Keep a private copy of your notes on GitHub</p>
            <p className="git-card__text">
              Every change is saved there with its history, so your notes survive even if this server
              doesn’t. Free, and about five minutes to set up — no GitHub experience needed.
            </p>
            <div className="git-card__actions">
              <button type="button" className="git-card__cta" onClick={() => setGuideOpen(true)}>
                Set up backup <ArrowRight size={16} aria-hidden="true" />
              </button>
            </div>
          </div>
        </div>
      ) : (
        <div className={`git-card${failing ? ' git-card--warn' : ''}`}>
          <span className="git-card__icon" aria-hidden="true">
            {failing ? <TriangleAlert size={20} /> : <CheckCircle2 size={20} />}
          </span>
          <div className="git-card__body">
            <p className="git-card__title">
              {data!.conflict ? 'Backup paused — the repository has changes Papyra doesn’t'
                : data!.lastError ? 'The last backup didn’t go through'
                  : 'Backing up automatically'}
            </p>
            <dl className="git-card__facts">
              <div><dt>To</dt><dd><a href={data!.remoteUrl.replace(/\.git$/, '')} target="_blank" rel="noreferrer">
                {repoLabel(data!.remoteUrl)} <ExternalLink size={12} aria-hidden="true" /></a></dd></div>
              <div><dt>Last backup</dt><dd>{when(data!.lastSyncUtc)}</dd></div>
              <div><dt>Schedule</dt><dd>Every 30 minutes, when something changed</dd></div>
            </dl>
            {data!.lastError && <p className="git-card__problem">{data!.lastError}</p>}
            {data!.conflict && (
              <p className="git-card__problem">
                Papyra stopped rather than overwrite what’s there. Point it at a new, empty repository,
                or bring the repository back in line with your notes, then back up again.
              </p>
            )}
            <div className="git-card__actions">
              <button type="button" className="settings__btn" disabled={run.isPending} onClick={() => run.mutate()}>
                <RefreshCw size={15} className={run.isPending ? 'git-spin' : undefined} aria-hidden="true" />
                {run.isPending ? 'Backing up…' : 'Back up now'}
              </button>
              <button type="button" className="settings__btn settings__btn--ghost" onClick={() => setGuideOpen(true)}>
                Change repository or token
              </button>
              <button
                type="button"
                className="settings__link"
                disabled={save.isPending}
                onClick={() => save.mutate({ remoteUrl: '', branch: data!.branch })}
              >
                Turn off backup
              </button>
            </div>
            {run.data && (
              <p className="settings__msg" role="status">
                <CheckCircle2 size={14} aria-hidden="true" />
                {run.data.status === 'pushed' ? 'Backed up.'
                  : run.data.status === 'clean' ? 'Already up to date.'
                    : run.data.status === 'conflict' ? 'Stopped — the repository has changes Papyra doesn’t.'
                      : `Didn’t work${run.data.detail ? `: ${run.data.detail}` : '.'}`}
              </p>
            )}
            {run.isError && <p className="settings__error">The backup couldn’t be started.</p>}
          </div>
        </div>
      )}
      {guideOpen && <SetupGuide initialUrl={data?.remoteUrl ?? ''} hasToken={Boolean(data?.hasToken)} onClose={() => setGuideOpen(false)} />}
    </>
  );
}

// ── The guide ──────────────────────────────────────────────────────────────────

const STEPS = ['Account', 'Repository', 'Access', 'Finish'] as const;

function SetupGuide({ initialUrl, hasToken, onClose }: { initialUrl: string; hasToken: boolean; onClose: () => void }) {
  const sheet = useRef<HTMLDivElement | null>(null);
  useDialogFocus(sheet);
  const save = useSaveGitConfig();
  const run = useRunGitSync();

  const [step, setStep] = useState(initialUrl ? 1 : 0);
  const [repoInput, setRepoInput] = useState(initialUrl.replace(/\.git$/, ''));
  const [token, setToken] = useState('');
  const [probe, setProbe] = useState<GitProbe | null>(null);
  const [checking, setChecking] = useState(false);
  const [finished, setFinished] = useState<string | null>(null);

  const repoUrl = normaliseRepoUrl(repoInput);
  const canUseStoredToken = hasToken && !token && initialUrl !== '';

  async function check() {
    if (!repoUrl) return;
    setChecking(true);
    setProbe(null);
    try {
      setProbe(await probeGitRemote(repoUrl, token));
    } catch {
      setProbe({ ok: false, error: 'Couldn’t reach Papyra’s server to check.' });
    } finally {
      setChecking(false);
    }
  }

  async function finish() {
    if (!repoUrl || !probe?.ok) return;
    const branch = probe.branches.includes('main') || probe.branches.length === 0 ? 'main' : probe.branches[0];
    await save.mutateAsync({ remoteUrl: repoUrl, branch, token: token.trim() || undefined });
    const result = await run.mutateAsync();
    setFinished(result.status);
  }

  function next() {
    const n = step + 1;
    setStep(n);
    if (n === 3) void check();
  }

  const nextDisabled =
    (step === 1 && !repoUrl) || (step === 2 && !token.trim() && !canUseStoredToken);

  return createPortal(
    <div className="git-guide__scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div
        ref={sheet}
        className="git-guide"
        role="dialog"
        aria-modal="true"
        aria-labelledby="git-guide-title"
        onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } }}
      >
        <header className="git-guide__head">
          <h2 id="git-guide-title" className="git-guide__title">Set up GitHub backup</h2>
          <button type="button" className="git-guide__close" aria-label="Close" onClick={onClose}><X size={18} /></button>
        </header>

        <ol className="git-guide__steps" aria-label="Steps">
          {STEPS.map((label, i) => (
            <li
              key={label}
              className={`git-guide__step${i === step ? ' is-current' : ''}${i < step ? ' is-done' : ''}`}
              aria-current={i === step ? 'step' : undefined}
            >
              <span className="git-guide__dot" aria-hidden="true">{i < step ? <Check size={12} /> : i + 1}</span>
              <span className="git-guide__step-label">{label}</span>
            </li>
          ))}
        </ol>

        <div className="git-guide__body">
          {step === 0 && (
            <>
              <h3 className="git-guide__lede">First, a GitHub account</h3>
              <p>
                GitHub is a free service for storing files with their full history. Papyra will keep a
                copy of your notes there, in a repository only you can see.
              </p>
              <div className="git-guide__choices">
                <a className="git-guide__choice" href="https://github.com/signup" target="_blank" rel="noreferrer">
                  <strong>I need an account</strong>
                  <span>Create one on GitHub (it’s free), then come back here.</span>
                  <ExternalLink size={14} aria-hidden="true" />
                </a>
                <button type="button" className="git-guide__choice" onClick={() => setStep(1)}>
                  <strong>I already have one</strong>
                  <span>Make sure you’re signed in to GitHub in this browser.</span>
                  <ArrowRight size={14} aria-hidden="true" />
                </button>
              </div>
            </>
          )}

          {step === 1 && (
            <>
              <h3 className="git-guide__lede">Create a private repository</h3>
              <p>A repository is the folder on GitHub your notes will live in.</p>
              <ol className="git-guide__howto">
                <li>
                  <a className="git-guide__open" href={NEW_REPO_URL} target="_blank" rel="noreferrer">
                    Open “New repository” on GitHub <ExternalLink size={14} aria-hidden="true" />
                  </a>
                  <span>The name and the <em>Private</em> setting are filled in for you.</span>
                </li>
                <li>Keep it <strong>Private</strong>, and leave “Add a README” and the other extras <strong>off</strong> —
                  Papyra needs it empty.</li>
                <li>Press <strong>Create repository</strong>, then copy the address from your browser’s address bar.</li>
              </ol>
              <label className="git-guide__field">
                Repository address
                <input
                  type="url"
                  value={repoInput}
                  onChange={(e) => { setRepoInput(e.target.value); setProbe(null); }}
                  placeholder={`https://github.com/your-name/${REPO_NAME}`}
                  autoFocus
                  {...NO_AUTOFILL}
                />
                {repoInput && !repoUrl && (
                  <span className="git-guide__warn">That doesn’t look like a repository address yet.</span>
                )}
                {repoUrl && <span className="git-guide__ok"><Check size={13} aria-hidden="true" /> {repoLabel(repoUrl)}</span>}
              </label>
            </>
          )}

          {step === 2 && (
            <>
              <h3 className="git-guide__lede">Let Papyra write to it</h3>
              <p>
                An access token is a password just for Papyra, limited to this one repository. You can
                revoke it on GitHub at any time.
              </p>
              <ol className="git-guide__howto">
                <li>
                  <a className="git-guide__open" href={NEW_TOKEN_URL} target="_blank" rel="noreferrer">
                    Open “New fine-grained token” on GitHub <ExternalLink size={14} aria-hidden="true" />
                  </a>
                </li>
                <li><strong>Token name:</strong> Papyra backup. <strong>Expiration:</strong> the longest you’re
                  comfortable with — Papyra emails you if backups start failing when it runs out.</li>
                <li><strong>Repository access:</strong> Only select repositories → {repoUrl ? repoLabel(repoUrl).split('/').pop() : REPO_NAME}.</li>
                <li><strong>Permissions:</strong> Repository permissions → <strong>Contents</strong> → Read and write.</li>
                <li>Press <strong>Generate token</strong> and copy it — GitHub shows it only once.</li>
              </ol>
              <label className="git-guide__field">
                Access token
                <input
                  {...MASKED_SECRET}
                  value={token}
                  onChange={(e) => { setToken(e.target.value); setProbe(null); }}
                  placeholder={canUseStoredToken ? 'Leave blank to keep the saved token' : 'github_pat_…'}
                  autoFocus
                />
              </label>
              <p className="git-guide__aside">
                Stuck on the fine-grained page?{' '}
                <a href={CLASSIC_TOKEN_URL} target="_blank" rel="noreferrer">Use a classic token instead</a>
                {' '}— everything is pre-filled, but it can reach all of your repositories.
              </p>
            </>
          )}

          {step === 3 && (
            <>
              <h3 className="git-guide__lede">{finished ? 'All set' : 'Check and finish'}</h3>
              {!finished && (
                <div className="git-guide__check" role="status" aria-live="polite">
                  {checking && <p><Loader2 size={16} className="git-spin" aria-hidden="true" /> Checking {repoUrl && repoLabel(repoUrl)}…</p>}
                  {probe?.ok && probe.empty && (
                    <p className="git-guide__good"><CheckCircle2 size={16} aria-hidden="true" /> Connected — the repository is empty and ready.</p>
                  )}
                  {probe?.ok && !probe.empty && (
                    <p className="git-guide__caution">
                      <TriangleAlert size={16} aria-hidden="true" />
                      Connected, but the repository already has files ({probe.branches.join(', ')}). If they aren’t
                      an earlier Papyra backup, the first backup will stop rather than overwrite them — an empty
                      repository is the safe choice.
                    </p>
                  )}
                  {probe && !probe.ok && (
                    <p className="git-guide__bad"><TriangleAlert size={16} aria-hidden="true" /> {probe.error}</p>
                  )}
                </div>
              )}
              {finished && (
                <div className="git-guide__check" role="status">
                  {finished === 'pushed' || finished === 'clean' ? (
                    <p className="git-guide__good">
                      <CheckCircle2 size={16} aria-hidden="true" /> Your notes are on GitHub. From now on Papyra backs
                      them up every 30 minutes whenever something changed.
                    </p>
                  ) : (
                    <p className="git-guide__caution">
                      <TriangleAlert size={16} aria-hidden="true" /> Saved, but the first backup didn’t go through
                      ({finished}). The Backup page shows what happened.
                    </p>
                  )}
                </div>
              )}
              {(save.isError || run.isError) && <p className="settings__error">Couldn’t save the backup settings.</p>}
            </>
          )}
        </div>

        {step > 0 && <footer className="git-guide__foot">
          {!finished && (
            <button type="button" className="settings__btn settings__btn--ghost" onClick={() => { setStep(step - 1); setProbe(null); }}>
              <ArrowLeft size={15} aria-hidden="true" /> Back
            </button>
          )}
          <span className="git-guide__spacer" />
          {step > 0 && step < 3 && (
            <button type="button" className="git-card__cta" disabled={nextDisabled} onClick={next}>
              {step === 2 ? 'Check connection' : 'Next'} <ArrowRight size={15} aria-hidden="true" />
            </button>
          )}
          {step === 3 && !finished && probe && !probe.ok && (
            <button type="button" className="git-card__cta" onClick={() => void check()}>Check again</button>
          )}
          {step === 3 && !finished && probe?.ok && (
            <button type="button" className="git-card__cta" disabled={save.isPending || run.isPending} onClick={() => void finish()}>
              {save.isPending || run.isPending ? 'Backing up…' : 'Save and back up now'}
            </button>
          )}
          {finished && <button type="button" className="git-card__cta" onClick={onClose}>Done</button>}
        </footer>}
      </div>
    </div>,
    document.body,
  );
}
