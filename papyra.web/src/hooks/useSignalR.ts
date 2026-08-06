import { useEffect, useState } from 'react';
import { HubConnectionBuilder, HubConnectionState, type HubConnection } from '@microsoft/signalr';
import { useQueryClient } from '@tanstack/react-query';
import { useFocus } from './useFocus';

export type ServerStatus = 'online' | 'offline';

// Global real-time bridge: connect to /hubs/notes, and on any external note event
// refresh the grid. In focus mode the refresh is buffered (see useFocus) so a remote
// sync never re-hydrates the grid mid-edit. The connection state drives the sidebar
// "Server Online/Offline" telemetry dot.
export function useSignalR(): ServerStatus {
  const queryClient = useQueryClient();
  const { onExternalUpdate } = useFocus();
  const [status, setStatus] = useState<ServerStatus>('offline');

  useEffect(() => {
    const connection: HubConnection = new HubConnectionBuilder()
      .withUrl('/hubs/notes')
      .withAutomaticReconnect()
      .build();

    const invalidateConflicts = () => queryClient.invalidateQueries({ queryKey: ['conflicts'] });

    // Note events go through the focus buffer; conflicts always refresh their banner.
    connection.on('NoteCreated', onExternalUpdate);
    connection.on('NoteUpdated', onExternalUpdate);
    connection.on('NoteDeleted', onExternalUpdate);
    // Sync conflict copies appear/resolve out of band; refresh the grid banners.
    connection.on('NoteConflict', invalidateConflicts);
    connection.on('ConflictResolved', invalidateConflicts);

    connection.onreconnecting(() => setStatus('offline'));
    connection.onreconnected(() => setStatus('online'));
    connection.onclose(() => setStatus('offline'));

    let cancelled = false;
    connection
      .start()
      .then(() => {
        if (!cancelled) setStatus('online');
      })
      .catch(() => {
        if (!cancelled) setStatus('offline');
      });

    return () => {
      cancelled = true;
      if (connection.state !== HubConnectionState.Disconnected) {
        void connection.stop();
      }
    };
  }, [queryClient, onExternalUpdate]);

  return status;
}
