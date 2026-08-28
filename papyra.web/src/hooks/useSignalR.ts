import { useEffect, useState } from 'react';
import { HubConnectionBuilder, HubConnectionState, type HubConnection } from '@microsoft/signalr';
import { useQueryClient } from '@tanstack/react-query';
import { useFocus } from './useFocus';
import { setSync } from '../lib/syncStatus';

export type ServerStatus = 'online' | 'offline';

/** Ceiling for reconnect backoff, and the fixed retry beat once it's reached. */
const RECONNECT_CAP_MS = 15_000;

// Global real-time bridge: connect to /hubs/notes, and on any external note event
// refresh the grid. In focus mode the refresh is buffered (see useFocus) so a remote
// sync never re-hydrates the grid mid-edit. The connection state drives the sidebar
// "Server Online/Offline" telemetry dot.
export function useSignalR(): ServerStatus {
  const queryClient = useQueryClient();
  const { onExternalUpdate } = useFocus();
  // The browser demo has no server and therefore no hub, so it is online from
  // the first paint — set here rather than in the effect below, which would be a
  // needless second render (and trips react-hooks/set-state-in-effect).
  const [status, setStatus] = useState<ServerStatus>(
    import.meta.env.VITE_DEMO ? 'online' : 'offline',
  );

  useEffect(() => {
    // Without this the demo would retry a websocket that can never open, every
    // 15 seconds, forever. The hub is the only network dependency in the app that
    // isn't a fetch, so it's the only one the demo has to stub.
    if (import.meta.env.VITE_DEMO) {
      setSync({ online: true });
      return;
    }

    const connection: HubConnection = new HubConnectionBuilder()
      .withUrl('/hubs/notes')
      // The stock policy gives up after ~60s. A self-hosted server can easily be
      // down longer than that (an image upgrade, a laptop asleep) and the app
      // would then sit there claiming "offline" until a manual reload. Back off
      // to 15s and keep trying forever.
      .withAutomaticReconnect({
        nextRetryDelayInMilliseconds: (ctx) =>
          Math.min(1000 * 2 ** ctx.previousRetryCount, RECONNECT_CAP_MS),
      })
      .build();

    const invalidateConflicts = () => queryClient.invalidateQueries({ queryKey: ['conflicts'] });

    // Note events go through the focus buffer; conflicts always refresh their banner.
    connection.on('NoteCreated', onExternalUpdate);
    connection.on('NoteUpdated', onExternalUpdate);
    connection.on('NoteDeleted', onExternalUpdate);
    // Sync conflict copies appear/resolve out of band; refresh the grid banners.
    connection.on('NoteConflict', invalidateConflicts);
    connection.on('ConflictResolved', invalidateConflicts);

    // The hub is the most sensitive reachability signal we have — it notices the
    // API dying while the browser still thinks it has a network. Mirror it into
    // the sync store so the outbox drains the moment the server comes back.
    const publish = (online: boolean) => { setStatus(online ? 'online' : 'offline'); setSync({ online }); };

    connection.onreconnecting(() => publish(false));
    connection.onreconnected(() => publish(true));

    let cancelled = false;
    let retry: ReturnType<typeof setTimeout> | undefined;

    // The automatic policy only covers a connection that came up once; a start
    // that never succeeded (server down when the tab opened) has to be retried
    // here, or the app stays "offline" forever after the API comes back.
    const connect = () => {
      if (cancelled || connection.state !== HubConnectionState.Disconnected) return;
      connection
        .start()
        .then(() => { if (!cancelled) publish(true); })
        .catch(() => {
          if (cancelled) return;
          publish(false);
          retry = setTimeout(connect, RECONNECT_CAP_MS);
        });
    };

    connection.onclose(() => {
      publish(false);
      retry = setTimeout(connect, RECONNECT_CAP_MS);
    });

    connect();

    return () => {
      cancelled = true;
      if (retry) clearTimeout(retry);
      if (connection.state !== HubConnectionState.Disconnected) {
        void connection.stop();
      }
    };
  }, [queryClient, onExternalUpdate]);

  return status;
}
