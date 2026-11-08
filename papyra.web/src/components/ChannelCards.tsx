import { useState } from 'react';
import { CheckCircle2, Copy, ExternalLink, Send, Trash2 } from 'lucide-react';
import { useConfirm } from '../lib/confirmContext';
import { useNotificationPrefs } from '../hooks/useInstanceConfig';
import { MASKED_SECRET } from '../lib/autofill';
import {
  CHANNEL_NAMES, CHAT_CHANNELS, telegramPolling, useConfirmDestination, useDestinations, useNtfyAddress, useRemoveDestination,
  useSetupDiscordWebhook, useSetupNtfy, useTelegramLink, useTestDestination, useUpdateDestination,
  type ChatChannel, type Destination, type NtfySetup,
} from '../hooks/useChannels';
import BusyButton from './BusyButton';
import SettingRow, { SettingGroup } from './SettingRow';
import './ChannelCards.css';

/**
 * Settings → Notifications → Where to send. Email is the account's address; each chat service the
 * administrator switched on gets a row here. A row reads as one line at rest (what is connected, or "Not
 * set up") and opens a short guided set-up, or — once connected — the few things you can do with it.
 * Nothing is sent to a place until you have said it is yours.
 */
export default function ChannelCards() {
  const { data } = useDestinations();
  const prefs = useNotificationPrefs().data;
  const emailConfigured = prefs?.emailConfigured ?? false;
  const hasAddress = prefs?.hasAddress ?? true;
  const available = data?.available ?? [];
  const byChannel = new Map((data?.destinations ?? []).map(d => [d.channel, d]));
  const shown = CHAT_CHANNELS.filter(c => available.includes(c) || byChannel.has(c));
  if (shown.length === 0) return null;

  return (
    <SettingGroup title="Where to send" id="where-to-send">
      <SettingRow
        label="Email"
        value={emailConfigured ? (hasAddress ? 'To your account address' : 'No address on your account') : null}
        empty="Not set up on this Papyra"
      />
      {shown.map(channel => (
        <ChannelRow key={channel} channel={channel} destination={byChannel.get(channel)} available={available.includes(channel)} />
      ))}
    </SettingGroup>
  );
}

function describe(d: Destination | undefined, available: boolean): { value: string | null; hint?: string } {
  if (!d) return { value: null };
  if (!available) return { value: `${d.label} · switched off by an administrator` };
  switch (d.state) {
    case 'unverified': return { value: 'Not confirmed yet', hint: 'Send a test, then say it arrived.' };
    case 'paused': return { value: 'Paused', hint: d.lastError ?? undefined };
    case 'attention': return { value: d.label, hint: d.lastError ? `Needs attention: ${d.lastError}` : 'Needs attention' };
    case 'off': return { value: `${d.label} · off` };
    default: return { value: d.label };
  }
}

function ChannelRow({ channel, destination, available }: { channel: ChatChannel; destination: Destination | undefined; available: boolean }) {
  const { value, hint } = describe(destination, available);
  const finishing = destination?.state === 'unverified';
  const action = !destination ? 'Set up' : finishing ? 'Finish' : 'Manage';

  const [open, setOpen] = useState(false);
  const [seen, setSeen] = useState(destination?.id);
  if (destination?.id !== seen) {
    setSeen(destination?.id);
    // A chat that connects by itself (Telegram, from its link) folds away the steps that were waiting for it.
    if (channel === 'telegram' && destination) setOpen(false);
  }

  return (
    <SettingRow label={CHANNEL_NAMES[channel]} value={value} empty="Not set up" hint={hint} action={action} actionDisabled={!available && !destination}
      open={open} onOpenChange={setOpen}>
      {close => (destination && !finishing
        ? <Manage destination={destination} close={close} />
        : channel === 'ntfy' ? <SetupNtfy existing={destination} close={close} />
        : channel === 'discord' ? <SetupDiscord existing={destination} close={close} />
        : <SetupTelegram close={close} />)}
    </SettingRow>
  );
}

// ── Small pieces ────────────────────────────────────────────────────────────────

function CopyButton({ text, label }: { text: string; label: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="settings__btn settings__btn--quiet"
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(() => { setDone(true); setTimeout(() => setDone(false), 1500); });
      }}
    >
      {done ? <CheckCircle2 size={15} aria-hidden="true" /> : <Copy size={15} aria-hidden="true" />} {done ? 'Copied' : label}
    </button>
  );
}

/** Send a test, then let the person say it arrived — the last step of any "give us an address" set-up. */
function TestAndConfirm({ id, name, alreadyTested, close }: { id: number; name: string; alreadyTested: boolean; close: () => void }) {
  const test = useTestDestination();
  const confirm = useConfirmDestination();
  const passed = alreadyTested || test.data?.ok === true;

  return (
    <div className="channel-step">
      <p className="channel-step__text">Send a test to {name}. Did it arrive?</p>
      <div className="settings__form-actions">
        <BusyButton type="button" className="settings__btn settings__btn--quiet" busy={test.isPending} busyLabel="Sending…" onClick={() => test.mutate(id)}>
          <Send size={15} aria-hidden="true" /> Send a test
        </BusyButton>
        <BusyButton
          type="button" className="settings__btn" disabled={!passed} busy={confirm.isPending} busyLabel="Saving…"
          onClick={async () => {
            try { await confirm.mutateAsync(id); } catch { return; } // the error shows below
            close();
          }}
        >
          Yes, it arrived
        </BusyButton>
        <button type="button" className="settings__btn settings__btn--quiet" onClick={close}>Not now</button>
      </div>
      <div aria-live="polite">
        {test.data?.ok && <p className="settings__msg"><CheckCircle2 size={15} aria-hidden="true" /> Sent. Look for it in {name}.</p>}
        {test.data && !test.data.ok && <p className="settings__error">{test.data.error ?? 'It did not go through.'}</p>}
        {test.isError && <p className="settings__error">{(test.error as Error).message}</p>}
        {confirm.isError && <p className="settings__error">{(confirm.error as Error).message}</p>}
      </div>
    </div>
  );
}

// ── ntfy ───────────────────────────────────────────────────────────────────────

function SetupNtfy({ existing, close }: { existing: Destination | undefined; close: () => void }) {
  const setup = useSetupNtfy();
  const address = useNtfyAddress();
  const [topic, setTopic] = useState('');
  const created: NtfySetup | undefined = setup.data;
  const id = created?.id ?? existing?.id;
  const shown = created ?? address.data;

  if (id === undefined) {
    return (
      <form className="settings__form" onSubmit={e => { e.preventDefault(); setup.mutate(topic); }}>
        <label className="settings__field">Topic
          <input type="text" value={topic} autoFocus maxLength={64} placeholder="Leave blank for a long random one"
            autoComplete="off" spellCheck={false} onChange={e => setTopic(e.target.value)} />
        </label>
        <p className="channel-step__text">The topic is the only thing keeping your notifications private, so a long one is safer.</p>
        {setup.isError && <p className="settings__error" role="alert">{(setup.error as Error).message}</p>}
        <div className="settings__form-actions">
          <BusyButton type="submit" className="settings__btn" busy={setup.isPending} busyLabel="Creating…">Continue</BusyButton>
          <button type="button" className="settings__btn settings__btn--quiet" onClick={close}>Cancel</button>
        </div>
      </form>
    );
  }

  return (
    <div className="settings__form">
      <div className="channel-step">
        <p className="channel-step__text">In the ntfy app, subscribe to this topic.</p>
        {shown ? (
          <div className="channel-code">
            <code>{shown.topic}</code>
            <CopyButton text={shown.topic} label="Copy topic" />
          </div>
        ) : (
          <BusyButton type="button" className="settings__btn settings__btn--quiet" busy={address.isPending} busyLabel="Loading…" onClick={() => address.mutate(id)}>
            Show my topic
          </BusyButton>
        )}
        {created?.weakTopic && <p className="settings__error" role="note">That topic is short and easy to guess. Anyone who guesses it can read these.</p>}
        {address.isError && <p className="settings__error">{(address.error as Error).message}</p>}
      </div>
      <TestAndConfirm id={id} name="ntfy" alreadyTested={existing?.lastOkUtc != null} close={close} />
    </div>
  );
}

// ── Discord ────────────────────────────────────────────────────────────────────

function SetupDiscord({ existing, close }: { existing: Destination | undefined; close: () => void }) {
  const setup = useSetupDiscordWebhook();
  const [url, setUrl] = useState('');
  const id = setup.data?.id ?? existing?.id;

  if (id === undefined) {
    return (
      <form className="settings__form" onSubmit={e => { e.preventDefault(); setup.mutate(url.trim()); }}>
        <label className="settings__field">Webhook address
          <input {...MASKED_SECRET} value={url} autoFocus placeholder="https://discord.com/api/webhooks/…" onChange={e => setUrl(e.target.value)} />
        </label>
        <p className="channel-step__text">In Discord: Server Settings → Integrations → Webhooks → New Webhook → Copy Webhook URL.</p>
        <p className="channel-step__text">Everyone who can read that channel can read these messages. Use a private one.</p>
        {setup.isError && <p className="settings__error" role="alert">{(setup.error as Error).message}</p>}
        <div className="settings__form-actions">
          <BusyButton type="submit" className="settings__btn" disabled={url.trim() === ''} busy={setup.isPending} busyLabel="Connecting…">Continue</BusyButton>
          <button type="button" className="settings__btn settings__btn--quiet" onClick={close}>Cancel</button>
        </div>
      </form>
    );
  }

  return (
    <div className="settings__form">
      <TestAndConfirm id={id} name="Discord" alreadyTested={existing?.lastOkUtc != null} close={close} />
    </div>
  );
}

// ── Telegram ───────────────────────────────────────────────────────────────────

function SetupTelegram({ close }: { close: () => void }) {
  const link = useTelegramLink();
  // While the link is open, keep looking: pressing Start in Telegram connects the chat, and this row turns into "Manage".
  useDestinations(link.data ? telegramPolling.ms : false);

  return (
    <div className="settings__form">
      {!link.data ? (
        <div className="channel-step">
          <p className="channel-step__text">You will open a link in Telegram and press Start. That connects this chat to your account.</p>
          {link.isError && <p className="settings__error" role="alert">{(link.error as Error).message}</p>}
          <div className="settings__form-actions">
            <BusyButton type="button" className="settings__btn" busy={link.isPending} busyLabel="Making a link…" onClick={() => link.mutate()}>
              Get a link
            </BusyButton>
            <button type="button" className="settings__btn settings__btn--quiet" onClick={close}>Cancel</button>
          </div>
        </div>
      ) : (
        <div className="channel-step">
          <p className="channel-step__text">Open this in Telegram and press Start. It works for 10 minutes, once.</p>
          <div className="settings__form-actions">
            <a className="settings__btn" href={link.data.url} target="_blank" rel="noreferrer noopener">
              <ExternalLink size={15} aria-hidden="true" /> Open Telegram
            </a>
            <CopyButton text={link.data.url} label="Copy link" />
            <button type="button" className="settings__btn settings__btn--quiet" onClick={close}>Close</button>
          </div>
          <p className="channel-step__text" aria-live="polite">Waiting for you to press Start… this updates by itself.</p>
        </div>
      )}
    </div>
  );
}

// ── A connected place ───────────────────────────────────────────────────────────

function Manage({ destination, close }: { destination: Destination; close: () => void }) {
  const confirm = useConfirm();
  const update = useUpdateDestination();
  const test = useTestDestination();
  const remove = useRemoveDestination();
  const address = useNtfyAddress();
  const name = CHANNEL_NAMES[destination.channel];
  const paused = destination.state === 'paused';

  async function removeIt() {
    const ok = await confirm({
      title: `Disconnect ${name}?`,
      body: `Notifications stop going there. You can connect it again whenever you like.`,
      confirmLabel: 'Disconnect',
      destructive: true,
    });
    if (ok) await remove.mutateAsync(destination.id).then(close, () => undefined);
  }

  return (
    <div className="settings__form">
      {paused && (
        <div className="settings__callout" role="note">
          <div>
            <strong>Paused.</strong>
            <p>{destination.lastError ?? 'Papyra stopped sending here.'}</p>
          </div>
          <BusyButton type="button" className="settings__btn" busy={update.isPending} busyLabel="Turning on…"
            onClick={() => update.mutate({ id: destination.id, enabled: true })}>
            Turn back on
          </BusyButton>
        </div>
      )}

      {!paused && (
        <label className="settings__field settings__field--inline">
          <input type="checkbox" role="switch" className="switch" checked={destination.enabled}
            onChange={e => update.mutate({ id: destination.id, enabled: e.target.checked })} />
          <span>Send notifications here</span>
        </label>
      )}

      <fieldset className="channel-tier">
        <legend>What it shows</legend>
        <label>
          <input type="radio" name={`tier-${destination.id}`} checked={destination.privacyTier === 'minimal'}
            onChange={() => update.mutate({ id: destination.id, privacyTier: 'minimal' })} />
          A short line, like “You were mentioned in a note”
        </label>
        <label>
          <input type="radio" name={`tier-${destination.id}`} checked={destination.privacyTier === 'titles'}
            onChange={() => update.mutate({ id: destination.id, privacyTier: 'titles' })} />
          The line with names and note titles
        </label>
      </fieldset>

      <div className="settings__form-actions">
        <BusyButton type="button" className="settings__btn settings__btn--quiet" busy={test.isPending} busyLabel="Sending…" onClick={() => test.mutate(destination.id)}>
          <Send size={15} aria-hidden="true" /> Send a test
        </BusyButton>
        {destination.channel === 'ntfy' && !address.data && (
          <BusyButton type="button" className="settings__btn settings__btn--quiet" busy={address.isPending} busyLabel="Loading…" onClick={() => address.mutate(destination.id)}>
            Show my topic
          </BusyButton>
        )}
        <BusyButton type="button" className="settings__btn settings__btn--quiet" busy={remove.isPending} busyLabel="Disconnecting…" onClick={removeIt}>
          <Trash2 size={15} aria-hidden="true" /> Disconnect
        </BusyButton>
        <button type="button" className="settings__btn settings__btn--quiet" onClick={close}>Done</button>
      </div>

      {address.data && (
        <div className="channel-code">
          <code>{address.data.topic}</code>
          <CopyButton text={address.data.topic} label="Copy topic" />
        </div>
      )}
      <div aria-live="polite">
        {test.data?.ok && <p className="settings__msg"><CheckCircle2 size={15} aria-hidden="true" /> Sent. Look for it in {name}.</p>}
        {test.data && !test.data.ok && <p className="settings__error">{test.data.error ?? 'It did not go through.'}</p>}
        {(test.isError || update.isError || remove.isError) && (
          <p className="settings__error" role="alert">{((test.error ?? update.error ?? remove.error) as Error).message}</p>
        )}
      </div>
    </div>
  );
}
