import { useState, type FormEvent } from 'react';
import { CheckCircle2, Send } from 'lucide-react';
import { MASKED_SECRET } from '../lib/autofill';
import {
  ApiError, useChannelAdmin, useCheckDiscordBotAdmin, useCheckTelegramAdmin, useSaveAllowedHosts, useSaveDiscordAdmin, useSaveNtfyAdmin,
  useSaveTelegramAdmin, useTestDiscordAdmin, useTestNtfyAdmin, type ChannelAdmin,
} from '../hooks/useChannels';
import BusyButton from './BusyButton';
import LoadingBar from './LoadingBar';
import SettingRow, { SettingGroup } from './SettingRow';
import { useT } from '../i18n/store';
import { useServiceParam } from '../hooks/useServiceParam';
import ServiceMark from './ServiceMark';
import ServiceTabs, { type ServiceTabItem, type ServiceTone } from './ServiceTabs';

// Administration → Notifications (administrators). Each notification service is switched on here once, like the
// mail server; people then connect their own place to send to under Settings → Notifications. Tokens and
// webhook addresses go up and are sealed on the server — nothing here shows one again.

function Switch({ label, hint, checked, onChange }: { label: string; hint?: string; checked: boolean; onChange: (on: boolean) => void }) {
  return (
    <label className="settings__field settings__field--inline">
      <input type="checkbox" role="switch" className="switch" checked={checked} onChange={e => onChange(e.target.checked)} />
      <span className="setting-row__text">
        <span className="setting-row__label">{label}</span>
        {hint && <span className="setting-row__hint">{hint}</span>}
      </span>
    </label>
  );
}

function Result({ ok, error, doneText }: { ok?: boolean; error?: string | null; doneText: string }) {
  return (
    <div aria-live="polite">
      {ok && <p className="settings__msg"><CheckCircle2 size={15} aria-hidden="true" /> {doneText}</p>}
      {error && <p className="settings__error" role="alert">{error}</p>}
    </div>
  );
}

export default function ChannelsAdminPanel() {
  const t = useT();
  const { data, isLoading, isError } = useChannelAdmin();
  if (isLoading) return <div className="settings__panel"><LoadingBar label="Loading settings" /></div>;
  if (isError || !data) return <div className="settings__panel"><p className="settings__error">{t('settings.channels.loadError')}</p></div>;

  return (
    <div className="settings__panel">
      <ChannelTabs data={data} />
    </div>
  );
}

const SERVICES = ['ntfy', 'discord', 'telegram', 'network'] as const;
type Service = (typeof SERVICES)[number];

/** The old `?s=` links into this page (`channels-discord`, `discord-test`…) open the service they belong to. */
const SECTION_SERVICE: Record<string, Service> = {
  'channels-ntfy': 'ntfy', 'ntfy-test': 'ntfy',
  'channels-discord': 'discord', 'discord-check': 'discord', 'discord-test': 'discord',
  'channels-telegram': 'telegram', 'telegram-check': 'telegram',
  'channels-hosts': 'network',
};

type Chip = { tone: ServiceTone; text: string };

/** Where each service stands, for its tile: on and usable, needing a fix, set up but off, or not set up. */
function chipFor(service: Service, data: ChannelAdmin, t: ReturnType<typeof useT>): Chip {
  const on: Chip = { tone: 'on', text: t('service.state.on') };
  const off: Chip = { tone: 'off', text: t('service.state.off') };
  const unset: Chip = { tone: 'idle', text: t('service.state.unset') };
  const attention: Chip = { tone: 'attention', text: t('service.state.attention') };
  switch (service) {
    case 'ntfy': return data.ntfy.enabled ? on : off;
    case 'discord': {
      const d = data.discord;
      if (!d.enabled) return d.hasBotToken || d.webhooksAllowed ? off : unset;
      return d.hasBotToken || d.webhooksAllowed ? on : attention;      // on, but nobody has a way to connect
    }
    case 'telegram': {
      const g = data.telegram;
      if (!g.enabled) return g.hasToken ? off : unset;
      return g.hasToken && !g.pollError ? on : attention;
    }
    case 'network': {
      const n = data.allowedHosts.length;
      return n > 0 ? { tone: 'on', text: t('settings.channels.hostsCount', { count: n }) } : { tone: 'idle', text: t('settings.channels.hostsNone') };
    }
  }
}

const NAMES: Record<Service, string> = { ntfy: 'ntfy', discord: 'Discord', telegram: 'Telegram', network: '' };

function ChannelTabs({ data }: { data: ChannelAdmin }) {
  const t = useT();
  const [service, setService] = useServiceParam(SERVICES, 'ntfy', s => (s ? SECTION_SERVICE[s] ?? null : null));
  const items: ServiceTabItem[] = SERVICES.map(id => {
    const chip = chipFor(id, data, t);
    return {
      id,
      name: id === 'network' ? t('settings.channels.network') : NAMES[id],
      mark: <ServiceMark service={id} lit={chip.tone === 'on'} />,
      chip: chip.text,
      tone: chip.tone,
    };
  });
  return (
    <ServiceTabs label={t('settings.nav.channels')} items={items} value={service} onChange={setService}>
      {service === 'ntfy' && <NtfyGroup data={data} />}
      {service === 'discord' && <DiscordGroup data={data} />}
      {service === 'telegram' && <TelegramGroup data={data} />}
      {service === 'network' && <HostsGroup data={data} />}
    </ServiceTabs>
  );
}

// ── ntfy ───────────────────────────────────────────────────────────────────────

function NtfyGroup({ data }: { data: ChannelAdmin }) {
  const n = data.ntfy;
  const test = useTestNtfyAdmin();
  const [topic, setTopic] = useState('');

  return (
    <SettingGroup title="ntfy" id="channels-ntfy" titleHidden>
      <SettingRow label="Status" value={n.enabled ? 'On' : 'Off'} hint="Phone and desktop notifications from ntfy.sh or your own server.">
        {close => <NtfyEditor data={data} close={close} />}
      </SettingRow>
      <SettingRow label="Server" value={n.serverUrl || `${n.defaultServerUrl.replace(/^https?:\/\//, '')} (public)`} />
      <SettingRow label="Access token" value={n.hasToken ? 'Saved' : null} empty="None" />
      <SettingRow label="Test" value="Send a test message to a topic" action="Send…" id="ntfy-test">
        {close => (
          <div className="settings__form">
            <label className="settings__field">Topic
              <input type="text" value={topic} autoFocus autoComplete="off" spellCheck={false}
                onChange={e => setTopic(e.target.value)} />
            </label>
            <Result ok={test.data?.ok} error={test.data && !test.data.ok ? test.data.error : test.isError ? (test.error as Error).message : null}
              doneText="Sent. Look for it in the ntfy app." />
            <div className="settings__form-actions">
              <BusyButton type="button" className="settings__btn" disabled={topic.trim() === ''} busy={test.isPending} busyLabel="Sending…"
                onClick={() => test.mutate(topic.trim())}>
                <Send size={15} aria-hidden="true" /> Send
              </BusyButton>
              <button type="button" className="settings__btn settings__btn--quiet" onClick={close}>Done</button>
            </div>
          </div>
        )}
      </SettingRow>
    </SettingGroup>
  );
}

function NtfyEditor({ data, close }: { data: ChannelAdmin; close: () => void }) {
  const t = useT();
  const save = useSaveNtfyAdmin();
  const [enabled, setEnabled] = useState(data.ntfy.enabled);
  const [server, setServer] = useState(data.ntfy.serverUrl);
  const [token, setToken] = useState('');
  const error = save.error instanceof ApiError ? save.error : null;
  // A server on the admin's own network is allowed deliberately, in the same step as saving it.
  const needsAllow = error?.code === 'host_not_allowed' || (error?.code === 'needs_https');

  function write(allowHost: boolean) {
    save.mutate(
      { enabled, serverUrl: server.trim(), ...(token.trim() ? { token: token.trim() } : {}), ...(allowHost ? { allowHost: true } : {}) },
      { onSuccess: close },
    );
  }

  return (
    <form className="settings__form" onSubmit={(e: FormEvent) => { e.preventDefault(); write(false); }}>
      <Switch label={t('settings.channels.letUse', { service: 'ntfy' })} checked={enabled} onChange={setEnabled} />
      <label className="settings__field">Server
        <input type="url" value={server} placeholder={data.ntfy.defaultServerUrl} autoComplete="off" spellCheck={false}
          onChange={e => setServer(e.target.value)} />
      </label>
      <label className="settings__field">Access token
        <input {...MASKED_SECRET} value={token} placeholder={data.ntfy.hasToken ? 'Saved — leave blank to keep' : 'Optional'}
          onChange={e => setToken(e.target.value)} />
      </label>
      {error && (
        <div className="settings__callout" role="alert">
          <div>
            <strong>{needsAllow ? 'That server is on your own network.' : 'That server can’t be used.'}</strong>
            <p>{error.message}</p>
            {needsAllow && (
              <BusyButton type="button" className="settings__btn" busy={save.isPending} busyLabel="Saving…" onClick={() => write(true)}>
                Allow {error.host ?? 'this server'} and save
              </BusyButton>
            )}
          </div>
        </div>
      )}
      {save.isError && !error && <p className="settings__error" role="alert">{(save.error as Error).message}</p>}
      <div className="settings__form-actions">
        <BusyButton type="submit" className="settings__btn" busy={save.isPending} busyLabel="Saving…">Save</BusyButton>
        {data.ntfy.hasToken && (
          <BusyButton type="button" className="settings__btn settings__btn--quiet" busy={save.isPending}
            onClick={() => save.mutate({ token: '' }, { onSuccess: close })}>
            Remove token
          </BusyButton>
        )}
        <button type="button" className="settings__btn settings__btn--quiet" onClick={close}>Cancel</button>
      </div>
    </form>
  );
}

// ── Discord ────────────────────────────────────────────────────────────────────

function DiscordGroup({ data }: { data: ChannelAdmin }) {
  const t = useT();
  const d = data.discord;
  const test = useTestDiscordAdmin();
  const check = useCheckDiscordBotAdmin();
  const [url, setUrl] = useState('');

  return (
    <SettingGroup title="Discord" id="channels-discord" titleHidden>
      <SettingRow label="Status" value={d.enabled ? 'On' : 'Off'} hint={t('settings.channels.discord.hint')}>
        {close => <DiscordEditor data={data} close={close} />}
      </SettingRow>
      <SettingRow label="Direct messages" value={d.hasBotToken ? (d.botUsername ? `Bot ${d.botUsername}` : 'Bot saved') : null} empty="No bot yet"
        hint={d.hasBotToken ? undefined : 'Make a bot in the Discord developer portal and paste its token under Status.'} />
      {d.hasBotToken && (
        <SettingRow label="Check the bot" value="Ask Discord if the bot still works" action="Check" id="discord-check">
          {close => (
            <div className="settings__form">
              <Result ok={check.data?.ok} error={check.data && !check.data.ok ? check.data.error : check.isError ? (check.error as Error).message : null}
                doneText={`Discord knows the bot${check.data?.botUsername ? ` ${check.data.botUsername}` : ''}.`} />
              <div className="settings__form-actions">
                <BusyButton type="button" className="settings__btn" busy={check.isPending} busyLabel="Asking…" onClick={() => check.mutate()}>
                  Check now
                </BusyButton>
                <button type="button" className="settings__btn settings__btn--quiet" onClick={close}>Done</button>
              </div>
            </div>
          )}
        </SettingRow>
      )}
      <SettingRow label={t('settings.channels.discord.messagesRow')} value={d.webhooksAllowed ? 'People may connect one' : 'Not allowed'} />
      <SettingRow label="Test" value="Send a test message to a webhook" action="Send…" id="discord-test">
        {close => (
          <div className="settings__form">
            <label className="settings__field">Webhook address
              <input {...MASKED_SECRET} value={url} autoFocus placeholder="https://discord.com/api/webhooks/…" onChange={e => setUrl(e.target.value)} />
            </label>
            <Result ok={test.data?.ok} error={test.data && !test.data.ok ? test.data.error : test.isError ? (test.error as Error).message : null}
              doneText="Sent. Look for it in the channel." />
            <div className="settings__form-actions">
              <BusyButton type="button" className="settings__btn" disabled={url.trim() === ''} busy={test.isPending} busyLabel="Sending…"
                onClick={() => test.mutate(url.trim())}>
                <Send size={15} aria-hidden="true" /> Send
              </BusyButton>
              <button type="button" className="settings__btn settings__btn--quiet" onClick={close}>Done</button>
            </div>
          </div>
        )}
      </SettingRow>
    </SettingGroup>
  );
}

function DiscordEditor({ data, close }: { data: ChannelAdmin; close: () => void }) {
  const t = useT();
  const save = useSaveDiscordAdmin();
  const [enabled, setEnabled] = useState(data.discord.enabled);
  const [webhooks, setWebhooks] = useState(data.discord.webhooksAllowed);
  const [botToken, setBotToken] = useState('');

  return (
    <form className="settings__form" onSubmit={(e: FormEvent) => {
      e.preventDefault();
      save.mutate({ enabled, webhooksAllowed: webhooks, ...(botToken.trim() ? { botToken: botToken.trim() } : {}) }, { onSuccess: close });
    }}>
      <Switch label={t('settings.channels.letUse', { service: 'Discord' })} checked={enabled} onChange={setEnabled} />
      <Switch label={t('settings.channels.discord.allowLabel')} hint={t('settings.channels.discord.allowHint')} checked={webhooks} onChange={setWebhooks} />
      <label className="settings__field">Bot token (for direct messages)
        <input {...MASKED_SECRET} value={botToken} placeholder={data.discord.hasBotToken ? 'Saved — leave blank to keep' : 'Optional'}
          onChange={e => setBotToken(e.target.value)} />
      </label>
      {save.isError && <p className="settings__error" role="alert">{(save.error as Error).message}</p>}
      <div className="settings__form-actions">
        <BusyButton type="submit" className="settings__btn" busy={save.isPending} busyLabel="Checking…">Save</BusyButton>
        {data.discord.hasBotToken && (
          <BusyButton type="button" className="settings__btn settings__btn--quiet" busy={save.isPending}
            onClick={() => save.mutate({ botToken: '' }, { onSuccess: close })}>
            Remove bot
          </BusyButton>
        )}
        <button type="button" className="settings__btn settings__btn--quiet" onClick={close}>Cancel</button>
      </div>
    </form>
  );
}

// ── Telegram ───────────────────────────────────────────────────────────────────

function TelegramGroup({ data }: { data: ChannelAdmin }) {
  const t = data.telegram;
  const check = useCheckTelegramAdmin();

  return (
    <SettingGroup title="Telegram" id="channels-telegram" titleHidden>
      <SettingRow
        label="Status" value={t.enabled ? 'On' : 'Off'}
        hint={t.pollError ? `Not reading messages: ${t.pollError}` : 'Notifications to a chat with your bot.'}
      >
        {close => <TelegramEditor data={data} close={close} />}
      </SettingRow>
      <SettingRow label="Bot" value={t.botUsername ? `@${t.botUsername}` : null} empty="No bot yet"
        hint={t.hasToken ? undefined : 'Create one with BotFather and paste its token under Status.'} />
      {t.hasToken && (
        <SettingRow label="Check" value="Ask Telegram if the bot still works" action="Check" id="telegram-check">
          {close => (
            <div className="settings__form">
              <Result ok={check.data?.ok} error={check.data && !check.data.ok ? check.data.error : check.isError ? (check.error as Error).message : null}
                doneText={`Telegram knows the bot${check.data?.botUsername ? ` @${check.data.botUsername}` : ''}.`} />
              <div className="settings__form-actions">
                <BusyButton type="button" className="settings__btn" busy={check.isPending} busyLabel="Asking…" onClick={() => check.mutate()}>
                  Check now
                </BusyButton>
                <button type="button" className="settings__btn settings__btn--quiet" onClick={close}>Done</button>
              </div>
            </div>
          )}
        </SettingRow>
      )}
    </SettingGroup>
  );
}

function TelegramEditor({ data, close }: { data: ChannelAdmin; close: () => void }) {
  const t = useT();
  const save = useSaveTelegramAdmin();
  const [enabled, setEnabled] = useState(data.telegram.enabled);
  const [token, setToken] = useState('');

  return (
    <form className="settings__form" onSubmit={(e: FormEvent) => {
      e.preventDefault();
      save.mutate({ enabled, ...(token.trim() ? { token: token.trim() } : {}) }, { onSuccess: close });
    }}>
      <Switch label={t('settings.channels.letUse', { service: 'Telegram' })} checked={enabled} onChange={setEnabled} />
      <label className="settings__field">Bot token
        <input {...MASKED_SECRET} value={token} placeholder={data.telegram.hasToken ? 'Saved — leave blank to keep' : 'From BotFather'}
          onChange={e => setToken(e.target.value)} />
      </label>
      {save.isError && <p className="settings__error" role="alert">{(save.error as Error).message}</p>}
      <div className="settings__form-actions">
        <BusyButton type="submit" className="settings__btn" busy={save.isPending} busyLabel="Checking…">Save</BusyButton>
        {data.telegram.hasToken && (
          <BusyButton type="button" className="settings__btn settings__btn--quiet" busy={save.isPending}
            onClick={() => save.mutate({ token: '' }, { onSuccess: close })}>
            Remove bot
          </BusyButton>
        )}
        <button type="button" className="settings__btn settings__btn--quiet" onClick={close}>Cancel</button>
      </div>
    </form>
  );
}

// ── Hosts on your own network ───────────────────────────────────────────────────

function HostsGroup({ data }: { data: ChannelAdmin }) {
  const t = useT();
  return (
    <SettingGroup title={t('settings.channels.network')} id="channels-hosts" titleHidden>
      <SettingRow
        label={t('settings.channels.allowedServers')}
        value={data.allowedHosts.length > 0 ? data.allowedHosts.join(', ') : null}
        empty="None"
        hint={t('settings.channels.networkHint')}
      >
        {close => <HostsEditor hosts={data.allowedHosts} close={close} />}
      </SettingRow>
    </SettingGroup>
  );
}

function HostsEditor({ hosts, close }: { hosts: string[]; close: () => void }) {
  const save = useSaveAllowedHosts();
  const [text, setText] = useState(hosts.join('\n'));

  return (
    <form className="settings__form" onSubmit={(e: FormEvent) => {
      e.preventDefault();
      save.mutate(text.split('\n').map(h => h.trim()).filter(Boolean), { onSuccess: close });
    }}>
      <label className="settings__field">One name or address per line
        <textarea value={text} rows={4} autoFocus spellCheck={false} autoComplete="off" onChange={e => setText(e.target.value)} />
      </label>
      {save.isError && <p className="settings__error" role="alert">{(save.error as Error).message}</p>}
      <div className="settings__form-actions">
        <BusyButton type="submit" className="settings__btn" busy={save.isPending} busyLabel="Saving…">Save</BusyButton>
        <button type="button" className="settings__btn settings__btn--quiet" onClick={close}>Cancel</button>
      </div>
    </form>
  );
}
