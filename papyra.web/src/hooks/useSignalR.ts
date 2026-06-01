import { useEffect } from 'react';
import { HubConnectionBuilder, LogLevel } from '@microsoft/signalr';
import { useQueryClient } from '@tanstack/react-query';
import { NOTES_KEY, noteKey } from './useNotes';
import type { Note, NoteSummary } from '../types';

// Empty prefix = same-origin (production Docker); full URL = dev cross-origin
const HUB_URL = `${import.meta.env.VITE_API_URL ?? ''}/hubs/notes`;

export function useSignalR() {
  const qc = useQueryClient();

  useEffect(() => {
    const connection = new HubConnectionBuilder()
      .withUrl(HUB_URL, { withCredentials: true })
      .withAutomaticReconnect()
      .configureLogging(LogLevel.Warning)
      .build();

    connection.on('NoteCreated', (note: Note) => {
      qc.setQueryData<NoteSummary[]>(NOTES_KEY, old => {
        if (!old) return [note];
        // If a refetch already landed the real note, update it in place rather
        // than moving it to the end — prevents masonry grid reorder jitter.
        if (old.some(n => n.id === note.id)) {
          return old.map(n => n.id === note.id ? note : n);
        }
        // Strip any optimistic temp entry and append the confirmed note.
        return [...old.filter(n => !n.id.startsWith('temp-')), note];
      });
      qc.setQueryData<Note>(noteKey(note.id), note);
    });

    connection.on('NoteUpdated', (note: Note) => {
      qc.setQueryData<NoteSummary[]>(NOTES_KEY,
        old => (old ?? []).map(n => n.id === note.id ? note : n),
      );
      qc.setQueryData<Note>(noteKey(note.id), note);
    });

    connection.on('NoteDeleted', (id: string) => {
      qc.setQueryData<NoteSummary[]>(NOTES_KEY,
        old => (old ?? []).filter(n => n.id !== id),
      );
      qc.removeQueries({ queryKey: noteKey(id) });
    });

    connection.start().catch(err =>
      console.warn('[SignalR] Connection failed:', err),
    );

    return () => {
      connection.stop();
    };
  }, [qc]);
}
