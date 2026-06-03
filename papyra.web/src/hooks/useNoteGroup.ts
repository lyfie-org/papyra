import { useEffect, useCallback } from 'react';
import { useSignalRConn } from '../context/SignalRContext';

// Joins the SignalR group for a note and wires up delta receive/send.
// Used inside NoteEditorModal for collaborative live editing.
export function useNoteGroup(
  noteId: string | null,
  onDelta: (delta: string, senderId: string) => void,
) {
  const connection = useSignalRConn();

  useEffect(() => {
    if (!connection || !noteId) return;

    // Wait until connection is in Connected state before calling hub methods.
    const tryJoin = () => {
      if (connection.state === 'Connected') {
        connection.invoke('JoinNote', noteId).catch(console.warn);
      }
    };

    // If already connected, join immediately; otherwise wait for reconnect.
    if (connection.state === 'Connected') {
      connection.invoke('JoinNote', noteId).catch(console.warn);
    }

    const onReconnect = () => tryJoin();
    connection.onreconnected(onReconnect);

    return () => {
      if (connection.state === 'Connected') {
        connection.invoke('LeaveNote', noteId).catch(console.warn);
      }
    };
  }, [connection, noteId]);

  // Register the delta receiver.
  useEffect(() => {
    if (!connection) return;
    const handler = (rNoteId: string, delta: string, senderId: string) => {
      if (rNoteId === noteId) onDelta(delta, senderId);
    };
    connection.on('ReceiveContentDelta', handler);
    return () => connection.off('ReceiveContentDelta', handler);
  }, [connection, noteId, onDelta]);

  // Expose a function to send a markdown delta to the group.
  const sendDelta = useCallback((delta: string) => {
    if (!connection || !noteId || connection.state !== 'Connected') return;
    connection.invoke('SendContentDelta', noteId, delta).catch(console.warn);
  }, [connection, noteId]);

  return { sendDelta };
}
