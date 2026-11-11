import { useState } from 'react';
import { useT, type MessageKey } from '../i18n/store';
import { useServiceParam } from '../hooks/useServiceParam';
import ServiceMark from './ServiceMark';
import ServiceTabs, { type ServiceTabItem, type ServiceTone } from './ServiceTabs';
import { CheckCircle2, Copy, ExternalLink, Send, Trash2 } from 'lucide-react';
import { useConfirm } from '../lib/confirmContext';
import { useNotificationPrefs } from '../hooks/useInstanceConfig';
import { MASKED_SECRET } from '../lib/autofill';
import {
  CHANNEL_NAMES, telegramPolling, useConfirmDestination, useConfirmDiscordDirect, useDestinations, useNtfyAddress, useRemoveDestination,
  useSetupDiscordDirect, useSetupDiscordWebhook, useSetupNtfy, useTelegramLink, useTestDestination, useUpdateDestination,
  type ChatChannel, type Destination, type NtfySetup,
} from '../hooks/useChannels';
import BusyButton from './BusyButton';
import './ChannelCards.css';

/** The order the tiles are shown in. Email is yours already; the chat services follow. */
const TILE_ORDER: ChatChannel[] = ['ntfy', 'discord', 'telegram'];

type Chip = { tone: ServiceTone; text: MessageKey };

/** Where a place stands, for its tile. The words say it; the dot and the mark's colour only echo it. */
function chipFor(d: Destination | undefined, available: boolean): Chip {
  if (!d) return { tone: 'idle', text: 'service.state.unset' };
  if (!available) return { tone: 'off', text: 'service.state.offHere' };
  switch (d.state) {
    case 'unverified': return { tone: 'idle', text: 'service.state.unset' };
    case 'paused':
    case 'attention': return { tone: 'attention', text: 'service.state.attention' };
    case 'off': return { tone: 'off', text: 'service.state.turnedOff' };
    default: return { tone: 'on', text: 'service.state.connected' };
  }
}

/**
 * Settings → Notifications → Where to send. One tile per place: Email (your account's address) and each chat
 * service the administrator switched on. Choosing a tile opens that service below it: a short guided set-up when
 * nothing is connected, or the few things you can do once it is. Nothing is sent to a place until you have said it
 * is yours. Which tile is open lives in the address (`?service=telegram`).
 */
export default function ChannelCards() {
  const t = useT();
  const { data } = useDestinations();
  const prefs = useNotificationPrefs().data;
  const emailConfigured = prefs?.emailConfigured ?? false;
  const hasAddress = prefs?.hasAddress ?? true;
  const available = data?.available ?? [];
  const byChannel = new Map((data?.destinations ?? []).map(d => [d.channel, d]));
  const shown = TILE_ORDER.filter(c => available.includes(c) || byChannel.has(c));
  const ids = ['email', ...shown];
  const [service, setService] = useServiceParam(ids, 'email');
  if (shown.length === 0) return null;

  const emailChip: Chip = !emailConfigured ? { tone: 'off', text: 'service.state.offHere' }
    : hasAddress ? { tone: 'on', text: 'service.state.connected' } : { tone: 'attention', text: 'service.state.attention' };
  const items: ServiceTabItem[] = [
    { id: 'email', name: CHANNEL_NAMES.email, mark: <ServiceMark service="email" />, chip: t(emailChip.text), tone: emailChip.tone },
    ...shown.map(channel => {
      const chip = chipFor(byChannel.get(channel), available.includes(channel));
      return { id: channel, name: CHANNEL_NAMES[channel], mark: <ServiceMark service={channel} lit={chip.tone === 'on'} />, chip: t(chip.text), tone: chip.tone };
    }),
  ];
  const chosen = shown.find(c => c === service);

  return (
    <section className="setting-group" aria-labelledby="where-to-send">
      <h2 id="where-to-send" className="settings__subhead">{t('notifications.where.title')}</h2>
      <ServiceTabs label={t('notifications.where.title')} items={items} value={service} onChange={setService}>
        {chosen
          ? <ChannelPanel key={chosen} channel={chosen} destination={byChannel.get(chosen)} available={available.includes(chosen)} />
          : <EmailPanel configured={emailConfigured} hasAddress={hasAddress} />}
      </ServiceTabs>
    </section>
  );
}

function EmailPanel({ configured, hasAddress }: { configured: boolean; hasAddress: boolean }) {
  const t = useT();
  return (
    <div className="service-panel">
      <p className="service-panel__lede">{t(!configured ? 'notifications.email.off' : hasAddress ? 'notifications.email.ok' : 'notifications.email.noAddress')}</p>
    </div>
  );
}

const INTRO: Record<ChatChannel, MessageKey> = {
  ntfy: 'notifications.ntfy.intro', discord: 'notifications.discord.intro', telegram: 'notifications.telegram.intro',
};

function ChannelPanel({ channel, destination, available }: { channel: ChatChannel; destination: Destination | undefined; available: boolean }) {
  const t = useT();
  const [setting, setSetting] = useState(false);
  const finishing = destination?.state === 'unverified';
  const stop = () => setSetting(false);

  // Connected (or paused, or switched off by you): what you can do with it, right here.
  if (destination && !finishing) {
    return (
      <div className="service-panel">
        {!available && <p className="service-panel__lede">{t('notifications.service.offByAdmin')}</p>}
        {available && destination.state === 'attention' && (
          <p className="service-panel__lede service-panel__lede--warn">
            {destination.lastError ? t('notifications.service.needsAttention', { reason: destination.lastError }) : t('service.state.attention')}
          </p>
        )}
        <Manage destination={destination} close={stop} />
      </div>
    );
  }

  return (
    <div className="service-panel">
      <p className="service-panel__lede">{t(finishing ? 'notifications.service.unconfirmed' : INTRO[channel])}</p>
      {setting ? (
        channel === 'ntfy' ? <SetupNtfy existing={destination} close={stop} />
          : channel === 'discord' ? <SetupDiscord existing={destination} close={stop} />
          : <SetupTelegram close={stop} />
      ) : (
        <div className="settings__form-actions">
          <button type="button" className="settings__btn" onClick={() => setSetting(true)}>
            {t(finishing ? 'notifications.service.finish' : 'notifications.service.setUp')}
          </button>
        </div>
      )}
    </div>
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
  const t = useT();
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
        <p className="channel-step__text">{t('notifications.ntfy.topicHint')}</p>
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
  const t = useT();
  const { data } = useDestinations();
  const kinds = data?.discord ?? { webhook: true, dm: false };
  const [choice, setChoice] = useState<'dm' | 'webhook'>('dm');
  const [chosen, setChosen] = useState(false);
  const [codeSent, setCodeSent] = useState(false);

  // Picking up a set-up that was started: it goes on with the same kind. The code box is one element
  // whether the code was just sent or was sent earlier, so what is being typed survives the list refreshing.
  if (existing?.state === 'unverified' && existing.kind !== 'dm') {
    return <SetupDiscordWebhook existing={existing} close={close} />;
  }
  if ((existing?.state === 'unverified' && existing.kind === 'dm') || codeSent) {
    return <DiscordCode existing={existing} close={close} />;
  }

  if (!kinds.dm && !kinds.webhook) {
    return (
      <div className="settings__form">
        <p className="channel-step__text">{t('notifications.discord.notReady')}</p>
        <div className="settings__form-actions">
          <button type="button" className="settings__btn settings__btn--quiet" onClick={close}>Close</button>
        </div>
      </div>
    );
  }

  const kind: 'dm' | 'webhook' | null = kinds.dm && kinds.webhook ? (chosen ? choice : null) : kinds.dm ? 'dm' : 'webhook';
  if (kind === 'dm') return <SetupDiscordDirect onSent={() => setCodeSent(true)} close={close} />;
  if (kind === 'webhook') return <SetupDiscordWebhook existing={existing} close={close} />;

  return (
    <form className="settings__form" onSubmit={e => { e.preventDefault(); setChosen(true); }}>
      <fieldset className="channel-tier">
        <legend>How should Discord reach you?</legend>
        <label>
          <input type="radio" name="discord-kind" checked={choice === 'dm'} onChange={() => setChoice('dm')} />
          {t('notifications.discord.kindDm')}
        </label>
        <label>
          <input type="radio" name="discord-kind" checked={choice === 'webhook'} onChange={() => setChoice('webhook')} />
          {t('notifications.discord.kindWebhook')}
        </label>
      </fieldset>
      <div className="settings__form-actions">
        <button type="submit" className="settings__btn">Continue</button>
        <button type="button" className="settings__btn settings__btn--quiet" onClick={close}>Cancel</button>
      </div>
    </form>
  );
}

function SetupDiscordWebhook({ existing, close }: { existing: Destination | undefined; close: () => void }) {
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

/** Direct messages: the bot sends a code to the account, and typing it back shows the account is yours. */
function SetupDiscordDirect({ onSent, close }: { onSent: () => void; close: () => void }) {
  const t = useT();
  const send = useSetupDiscordDirect();
  const [userId, setUserId] = useState('');

  return (
    <form className="settings__form" onSubmit={e => { e.preventDefault(); send.mutate(userId, { onSuccess: onSent }); }}>
      <label className="settings__field">Your Discord user ID
        <input type="text" inputMode="numeric" value={userId} autoFocus autoComplete="off" spellCheck={false}
          placeholder="18 or 19 digits" onChange={e => setUserId(e.target.value)} />
      </label>
      <p className="channel-step__text">In Discord: Settings → Advanced → turn on Developer Mode, then right-click your name → Copy User ID.</p>
      <p className="channel-step__text">{t('notifications.discord.dmNeeds')}</p>
      {send.isError && <p className="settings__error" role="alert">{(send.error as Error).message}</p>}
      <div className="settings__form-actions">
        <BusyButton type="submit" className="settings__btn" disabled={userId.trim() === ''} busy={send.isPending} busyLabel="Sending…">
          Send me a code
        </BusyButton>
        <button type="button" className="settings__btn settings__btn--quiet" onClick={close}>Cancel</button>
      </div>
    </form>
  );
}

function DiscordCode({ existing, close }: { existing?: Destination; close: () => void }) {
  const confirm = useConfirmDiscordDirect();
  const remove = useRemoveDestination();
  const [code, setCode] = useState('');

  return (
    <form className="settings__form" onSubmit={async e => {
      e.preventDefault();
      try { await confirm.mutateAsync(code); } catch { return; } // the reason shows below
      close();
    }}>
      <label className="settings__field">Code from the bot
        <input type="text" value={code} autoFocus autoComplete="one-time-code" spellCheck={false} maxLength={12}
          placeholder="ABCD-EFGH" onChange={e => setCode(e.target.value)} />
      </label>
      <p className="channel-step__text">The bot sent it to you on Discord. It works for 10 minutes.</p>
      {confirm.isError && <p className="settings__error" role="alert">{(confirm.error as Error).message}</p>}
      <div className="settings__form-actions">
        <BusyButton type="submit" className="settings__btn" disabled={code.trim() === ''} busy={confirm.isPending} busyLabel="Checking…">
          Connect
        </BusyButton>
        {existing && (
          <BusyButton type="button" className="settings__btn settings__btn--quiet" busy={remove.isPending} busyLabel="Starting over…"
            onClick={() => remove.mutate(existing.id)}>
            Start over
          </BusyButton>
        )}
        <button type="button" className="settings__btn settings__btn--quiet" onClick={close}>Not now</button>
      </div>
    </form>
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
  const t = useT();
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
        <legend>{t('notifications.manage.shows')}</legend>
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
