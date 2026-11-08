import { AlertTriangle, Lock } from 'lucide-react';
import { useNotificationPrefs, useSaveNotificationPrefs, type NotificationEvent } from '../hooks/useInstanceConfig';
import { CHANNEL_NAMES, CHAT_CHANNELS, useDestinations } from '../hooks/useChannels';
import LoadingBar from './LoadingBar';
import './NotificationSettings.css';

/**
 * Everything Papyra can tell you about, grouped, one switch each.
 *
 * Security mail is listed too — switched on and locked — so the list is the
 * whole truth about what reaches your inbox, rather than leaving someone
 * wondering why a "password changed" email arrived after they turned email off.
 *
 * Each chat service you have connected and confirmed (see ChannelCards, which sits above
 * the list) gets a column of its own beside email, so each notification can go to different
 * places. Always-on security notices stay email only.
 */
export default function NotificationSettings() {
  const { data, isLoading, isError } = useNotificationPrefs();
  const destinations = useDestinations();
  const save = useSaveNotificationPrefs();

  if (isLoading) return <LoadingBar label="Loading notification settings" />;
  if (isError || !data) return <p className="settings__error">Couldn’t load your notification settings.</p>;

  const available = data.available ?? destinations.data?.available ?? [];
  // A chat service gets a column once a place for it is confirmed and the administrator still has it on.
  const chat = CHAT_CHANNELS.filter(c =>
    available.includes(c) && destinations.data?.destinations.some(d => d.channel === c && d.verified));
  const columns = ['email', ...chat];

  const byGroup = new Map<string, NotificationEvent[]>();
  for (const ev of data.events) byGroup.set(ev.group, [...(byGroup.get(ev.group) ?? []), ev]);

  function toggle(ev: NotificationEvent, channel: string, on: boolean) {
    save.mutate({ events: [{ id: ev.id, enabled: on, channel }] });
  }

  return (
    <>
      {!data.emailConfigured && chat.length === 0 && (
        <div className="settings__callout" role="note">
          <AlertTriangle size={18} aria-hidden="true" />
          <div>
            <strong>Email isn’t set up on this Papyra yet.</strong>
            <p>
              Your choices are saved, but nothing is sent until an administrator connects a mail
              server under Settings → Email.
            </p>
          </div>
        </div>
      )}
      {data.emailConfigured && !data.hasAddress && (
        <div className="settings__callout" role="note">
          <AlertTriangle size={18} aria-hidden="true" />
          <div>
            <strong>Your account has no email address.</strong>
            <p>Add one under Profile to receive any of these.</p>
          </div>
        </div>
      )}

      {data.groups.filter(g => byGroup.has(g.id)).map(group => (
        <section key={group.id} className="notify-group" aria-labelledby={`notify-${group.id}`}>
          <header className="notify-group__head">
            <h3 id={`notify-${group.id}`} className="notify-group__title">{group.label}</h3>
            <span className="notify-cols" data-cols={columns.length} aria-hidden="true">
              {columns.map(c => <span key={c} className="notify-group__channel">{CHANNEL_NAMES[c]}</span>)}
            </span>
          </header>
          <ul className="notify-list">
            {byGroup.get(group.id)!.map(ev => {
              const inputId = `notify-${ev.id}`;
              return (
                <li key={ev.id} className={`notify-row${ev.critical ? ' notify-row--locked' : ''}`}>
                  <label className="notify-row__text" htmlFor={inputId}>
                    <span className="notify-row__label">{ev.label}</span>
                    <span className="notify-row__desc">{ev.description}</span>
                  </label>
                  <span className="notify-row__control notify-cols" data-cols={columns.length}>
                    <span className="notify-row__cell">
                      {ev.critical && (
                        <span className="notify-row__always" title="Always sent — it keeps your account safe">
                          <Lock size={12} aria-hidden="true" /> <span className="notify-row__always-text">Always</span>
                        </span>
                      )}
                      <input
                        id={inputId}
                        type="checkbox"
                        role="switch"
                        className="switch"
                        checked={ev.critical || ev.email}
                        disabled={ev.critical}
                        aria-describedby={ev.critical ? `${inputId}-why` : undefined}
                        onChange={e => toggle(ev, 'email', e.target.checked)}
                      />
                      {ev.critical && (
                        <span id={`${inputId}-why`} className="sr-only">Always sent, can’t be switched off.</span>
                      )}
                    </span>
                    {chat.map(c => (
                      <span key={c} className="notify-row__cell">
                        {/* Always-on notices go by email only, so a chat cell would promise something false. */}
                        {!ev.critical && (
                          <input
                            id={`${inputId}-${c}`}
                            type="checkbox"
                            role="switch"
                            className="switch"
                            aria-label={`${ev.label} — ${CHANNEL_NAMES[c]}`}
                            checked={ev.chat?.[c] ?? false}
                            onChange={e => toggle(ev, c, e.target.checked)}
                          />
                        )}
                      </span>
                    ))}
                  </span>
                </li>
              );
            })}
          </ul>
        </section>
      ))}

      {save.isError && <p className="settings__error" role="alert">Couldn’t save that change.</p>}
    </>
  );
}
