import { useEffect } from 'react';
import { HubConnectionBuilder, LogLevel } from '@microsoft/signalr';
import { useQueryClient } from '@tanstack/react-query';
import { NOTES_KEY, noteKey } from './useNotes';
import type { Note, NoteSummary } from '../types';

const HUB_URL = 'http://localhost:5220/hubs/notes';

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
        // Avoid duplicate if optimistic entry is still present
        const filtered = old.filter(n => n.id !== note.id && !n.id.startsWith('temp-'));
        return [...filtered, note];
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
