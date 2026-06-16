import { useEffect, useState } from 'react';
import { HubConnectionBuilder, HubConnectionState, type HubConnection } from '@microsoft/signalr';
import { useQueryClient } from '@tanstack/react-query';

export type ServerStatus = 'online' | 'offline';

// Global real-time bridge: connect to /hubs/notes, and on any external note event
// invalidate the notes query so the grid re-hydrates. The connection state drives
// the sidebar "Server Online/Offline" telemetry dot.
export function useSignalR(): ServerStatus {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<ServerStatus>('offline');

  useEffect(() => {
    const connection: HubConnection = new HubConnectionBuilder()
      .withUrl('/hubs/notes')
      .withAutomaticReconnect()
      .build();

    const invalidate = () => queryClient.invalidateQueries({ queryKey: ['notes'] });
    const invalidateConflicts = () => queryClient.invalidateQueries({ queryKey: ['conflicts'] });

    connection.on('NoteCreated', invalidate);
    connection.on('NoteUpdated', invalidate);
    connection.on('NoteDeleted', invalidate);
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
  }, [queryClient]);

  return status;
}
