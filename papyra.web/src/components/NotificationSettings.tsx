import { AlertTriangle, Lock } from 'lucide-react';
import { useNotificationPrefs, useSaveNotificationPrefs, type NotificationEvent } from '../hooks/useInstanceConfig';
import LoadingBar from './LoadingBar';
import './NotificationSettings.css';

/**
 * Everything Papyra can tell you about, grouped, one switch each.
 *
 * Security mail is listed too — switched on and locked — so the list is the
 * whole truth about what reaches your inbox, rather than leaving someone
 * wondering why a "password changed" email arrived after they turned email off.
 *
 * Email is the only channel today. The server sends `channels`, and each row is
 * laid out as a channel column, so push to the phone app slots in beside it.
 */
export default function NotificationSettings() {
  const { data, isLoading, isError } = useNotificationPrefs();
  const save = useSaveNotificationPrefs();

  if (isLoading) return <LoadingBar label="Loading notification settings" />;
  if (isError || !data) return <p className="settings__error">Couldn’t load your notification settings.</p>;

  const byGroup = new Map<string, NotificationEvent[]>();
  for (const ev of data.events) byGroup.set(ev.group, [...(byGroup.get(ev.group) ?? []), ev]);

  function toggle(ev: NotificationEvent, on: boolean) {
    save.mutate({ events: [{ id: ev.id, enabled: on, channel: 'email' }] });
  }

  return (
    <>
      {!data.emailConfigured && (
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
            <span className="notify-group__channel" aria-hidden="true">Email</span>
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
                  <span className="notify-row__control">
                    {ev.critical && (
                      <span className="notify-row__always" title="Always sent — it keeps your account safe">
                        <Lock size={12} aria-hidden="true" /> Always
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
                      onChange={e => toggle(ev, e.target.checked)}
                    />
                    {ev.critical && (
                      <span id={`${inputId}-why`} className="sr-only">Always sent, can’t be switched off.</span>
                    )}
                  </span>
                </li>
              );
            })}
          </ul>
        </section>
      ))}

      <p className="settings__hint">
        The bell in the top bar always shows everything, whatever you choose here — these switches
        only decide what is also emailed to you.
      </p>
      {save.isError && <p className="settings__error" role="alert">Couldn’t save that change.</p>}
    </>
  );
}
