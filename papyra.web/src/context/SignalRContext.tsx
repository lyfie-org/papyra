import {
  createContext,
  useContext,
  useEffect,
  useRef,
  type ReactNode,
} from 'react';
import {
  HubConnectionBuilder,
  HubConnection,
  LogLevel,
} from '@microsoft/signalr';
import { useQueryClient } from '@tanstack/react-query';
import { NOTES_KEY } from '../hooks/useNotes';
import type { NoteSummary } from '../types';

const HUB_URL = `${import.meta.env.VITE_API_URL ?? ''}/hubs/notes`;

interface SignalRContextValue {
  /** The underlying HubConnection, or null if not yet connected. */
  connection: HubConnection | null;
}

const SignalRContext = createContext<SignalRContextValue>({ connection: null });

export function SignalRProvider({ children }: { children: ReactNode }) {
  const qc             = useQueryClient();
  const connRef        = useRef<HubConnection | null>(null);
  // Trigger re-render of consumers when connection is established
  const ctxRef         = useRef<SignalRContextValue>({ connection: null });

  useEffect(() => {
    const conn = new HubConnectionBuilder()
      .withUrl(HUB_URL, { withCredentials: true })
      .withAutomaticReconnect()
      .configureLogging(LogLevel.Warning)
      .build();

    connRef.current     = conn;
    ctxRef.current      = { connection: conn };

    // Backend sends NoteMetadata (no content) — update list cache only.
    // Detail cache (noteKey) keeps its own content from the initial GET /notes/{id}.
    conn.on('NoteCreated', (note: NoteSummary) => {
      qc.setQueryData<NoteSummary[]>(NOTES_KEY, old => {
        if (!old) return [note];
        if (old.some(n => n.id === note.id))
          return old.map(n => n.id === note.id ? note : n);
        return [...old.filter(n => !n.id.startsWith('temp-')), note];
      });
    });

    conn.on('NoteUpdated', (note: NoteSummary) => {
      qc.setQueryData<NoteSummary[]>(NOTES_KEY,
        old => (old ?? []).map(n => n.id === note.id ? note : n),
      );
    });

    conn.on('NoteDeleted', (id: string) => {
      qc.setQueryData<NoteSummary[]>(NOTES_KEY,
        old => (old ?? []).filter(n => n.id !== id),
      );
      qc.removeQueries({ queryKey: ['notes', id] });
    });

    conn.start().catch(err =>
      console.warn('[SignalR] Connection failed:', err),
    );

    return () => { conn.stop(); };
  }, [qc]);

  return (
    <SignalRContext.Provider value={ctxRef.current}>
      {children}
    </SignalRContext.Provider>
  );
}

export function useSignalRConn() {
  return useContext(SignalRContext).connection;
}
