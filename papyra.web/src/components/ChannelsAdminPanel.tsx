import { useState, type FormEvent } from 'react';
import { CheckCircle2, Send } from 'lucide-react';
import { MASKED_SECRET } from '../lib/autofill';
import {
  ApiError, useChannelAdmin, useCheckTelegramAdmin, useSaveAllowedHosts, useSaveDiscordAdmin, useSaveNtfyAdmin,
  useSaveTelegramAdmin, useTestDiscordAdmin, useTestNtfyAdmin, type ChannelAdmin,
} from '../hooks/useChannels';
import BusyButton from './BusyButton';
import LoadingBar from './LoadingBar';
import SettingRow, { SettingGroup } from './SettingRow';

// Settings → Chat notifications (administrators). Each chat service is switched on here once, like the
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
  const { data, isLoading, isError } = useChannelAdmin();
  if (isLoading) return <div className="settings__panel"><LoadingBar label="Loading settings" /></div>;
  if (isError || !data) return <div className="settings__panel"><p className="settings__error">Couldn’t load the chat notification settings.</p></div>;

  return (
    <div className="settings__panel">
      <NtfyGroup data={data} />
      <DiscordGroup data={data} />
      <TelegramGroup data={data} />
      <HostsGroup data={data} />
    </div>
  );
}

// ── ntfy ───────────────────────────────────────────────────────────────────────

function NtfyGroup({ data }: { data: ChannelAdmin }) {
  const n = data.ntfy;
  const test = useTestNtfyAdmin();
  const [topic, setTopic] = useState('');

  return (
    <SettingGroup title="ntfy" id="channels-ntfy">
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
      <Switch label="Let people send to ntfy" checked={enabled} onChange={setEnabled} />
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
  const d = data.discord;
  const test = useTestDiscordAdmin();
  const [url, setUrl] = useState('');

  return (
    <SettingGroup title="Discord" id="channels-discord">
      <SettingRow label="Status" value={d.enabled ? 'On' : 'Off'} hint="Notifications into a Discord channel through a webhook.">
        {close => <DiscordEditor data={data} close={close} />}
      </SettingRow>
      <SettingRow label="Channel webhooks" value={d.webhooksAllowed ? 'People may connect one' : 'Not allowed'} />
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
  const save = useSaveDiscordAdmin();
  const [enabled, setEnabled] = useState(data.discord.enabled);
  const [webhooks, setWebhooks] = useState(data.discord.webhooksAllowed);

  return (
    <form className="settings__form" onSubmit={(e: FormEvent) => {
      e.preventDefault();
      save.mutate({ enabled, webhooksAllowed: webhooks }, { onSuccess: close });
    }}>
      <Switch label="Let people send to Discord" checked={enabled} onChange={setEnabled} />
      <Switch label="Allow channel webhooks" hint="A webhook posts into a channel everyone in it can read." checked={webhooks} onChange={setWebhooks} />
      {save.isError && <p className="settings__error" role="alert">{(save.error as Error).message}</p>}
      <div className="settings__form-actions">
        <BusyButton type="submit" className="settings__btn" busy={save.isPending} busyLabel="Saving…">Save</BusyButton>
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
    <SettingGroup title="Telegram" id="channels-telegram">
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
  const save = useSaveTelegramAdmin();
  const [enabled, setEnabled] = useState(data.telegram.enabled);
  const [token, setToken] = useState('');

  return (
    <form className="settings__form" onSubmit={(e: FormEvent) => {
      e.preventDefault();
      save.mutate({ enabled, ...(token.trim() ? { token: token.trim() } : {}) }, { onSuccess: close });
    }}>
      <Switch label="Let people send to Telegram" checked={enabled} onChange={setEnabled} />
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
  return (
    <SettingGroup title="Servers on your network" id="channels-hosts">
      <SettingRow
        label="Allowed hosts"
        value={data.allowedHosts.length > 0 ? data.allowedHosts.join(', ') : null}
        empty="None"
        hint="Papyra only connects to the open internet unless you list a server here."
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
