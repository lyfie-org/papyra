import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import {
  X, Sparkles, CornerDownLeft, Download, AlertTriangle, Plus, MessageSquare, Trash2, Pencil,
} from 'lucide-react';
import { useAiStatus, useAiModels } from '../hooks/useAi';
import { useAuth } from '../hooks/useAuth';
import { friendlyModelName, providerLabel } from '../lib/aiModels';
import {
  CHAT_SESSIONS_KEY, chatThreadKey, useChatSessions, useChatThread,
  useDeleteChatSession, useRenameChatSession,
  type ChatMessage, type Citation,
} from '../hooks/useChatSessions';
import { useConfirm } from '../lib/confirmContext';
import './ChatPanel.css';

/**
 * Ask-your-notes side panel.
 *
 * Conversations are kept now, so this is a thread rather than one question and
 * one answer: earlier turns are on screen, the model is given them, and "what
 * about the second one?" resolves. The panel streams the current answer over
 * NDJSON and shows the notes each answer was grounded in.
 *
 * It opens by asking the server whether the assistant can actually answer — it
 * used to return nothing when no model was installed, which read as a broken
 * feature rather than an unconfigured one.
 */
export default function ChatPanel({ onClose }: { onClose: () => void }) {
  const [question, setQuestion] = useState('');
  const [sessionId, setSessionId] = useState<number | null>(null);
  /** The turn being streamed right now — not yet in the saved thread. */
  const [pending, setPending] = useState<{ question: string; answer: string; citations: Citation[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  /** The conversation being renamed in place. Papyra has no browser dialogs. */
  const [renaming, setRenaming] = useState<{ id: number; title: string } | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);

  const { user } = useAuth();
  const isAdmin = user?.role === 'Admin';
  const confirm = useConfirm();
  const queryClient = useQueryClient();
  const { data: status, isLoading: statusLoading } = useAiStatus();
  const { data: choices } = useAiModels();
  const { data: sessions } = useChatSessions(true);
  const { data: thread } = useChatThread(sessionId);
  const rename = useRenameChatSession();
  const remove = useDeleteChatSession();

  // Follow the conversation as it grows, including while tokens arrive.
  useEffect(() => {
    bodyRef.current?.scrollTo({ top: bodyRef.current.scrollHeight });
  }, [thread?.messages.length, pending?.answer]);

  async function ask(e: React.FormEvent) {
    e.preventDefault();
    const q = question.trim();
    if (!q || busy) return;

    setBusy(true);
    setError(null);
    setQuestion('');
    setPending({ question: q, answer: '', citations: [] });

    try {
      const res = await fetch('/api/ai/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: q, sessionId }),
      });
      if (!res.ok || !res.body) throw new Error('Could not reach the assistant.');

      // NDJSON: the session first, then citations, then a token frame per
      // fragment, then done.
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let landedIn = sessionId;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? ''; // keep the partial line for the next chunk
        for (const line of lines) {
          if (!line.trim()) continue;
          const frame = JSON.parse(line);
          if (frame.type === 'session') {
            // A first question creates the thread server-side; adopt it so the
            // next question continues rather than starting another.
            landedIn = frame.sessionId as number;
            setSessionId(landedIn);
          } else if (frame.type === 'citations') {
            setPending(p => (p ? { ...p, citations: frame.citations ?? [] } : p));
          } else if (frame.type === 'token') {
            setPending(p => (p ? { ...p, answer: p.answer + frame.value } : p));
          } else if (frame.type === 'done' && frame.error) {
            setError(frame.error);
          }
        }
      }

      // The saved thread is the record; drop the local copy once it has it.
      if (landedIn !== null) await queryClient.invalidateQueries({ queryKey: chatThreadKey(landedIn) });
      await queryClient.invalidateQueries({ queryKey: CHAT_SESSIONS_KEY });
      setPending(null);
    } catch {
      setError('Could not reach the assistant.');
      setPending(null);
    } finally {
      setBusy(false);
    }
  }

  function startNew() {
    setSessionId(null);
    setPending(null);
    setError(null);
    setShowHistory(false);
  }

  async function commitRename(e: React.FormEvent) {
    e.preventDefault();
    if (!renaming) return;
    const title = renaming.title.trim();
    if (title) await rename.mutateAsync({ id: renaming.id, title });
    setRenaming(null);
  }

  async function deleteSession(id: number, title: string) {
    if (!(await confirm({
      title: `Delete “${title}”?`,
      body: 'The questions and answers in this conversation are removed. Your notes are untouched.',
      confirmLabel: 'Delete conversation',
      destructive: true,
    }))) return;
    await remove.mutateAsync(id);
    if (sessionId === id) startNew();
  }

  const messages: ChatMessage[] = thread?.messages ?? [];
  const empty = messages.length === 0 && pending === null;

  return (
    <aside className="chat-panel" aria-label="Ask your notes">
      <header className="chat-panel__head">
        <h2 className="chat-panel__title"><Sparkles size={16} /> Ask your notes</h2>
        <div className="chat-panel__head-actions">
          <button
            type="button"
            className="chat-panel__icon"
            aria-label="Past conversations"
            aria-expanded={showHistory}
            onClick={() => setShowHistory(o => !o)}
          >
            <MessageSquare size={16} />
          </button>
          <button type="button" className="chat-panel__icon" aria-label="New conversation" onClick={startNew}>
            <Plus size={16} />
          </button>
          <button type="button" className="chat-panel__close" aria-label="Close assistant" onClick={onClose}>
            <X size={16} />
          </button>
        </div>
      </header>

      {showHistory && (
        <div className="chat-panel__history">
          {(sessions ?? []).length === 0 && (
            <p className="chat-panel__history-empty">Nothing yet — ask a question and it will be kept here.</p>
          )}
          <ul>
            {(sessions ?? []).map(s => (
              <li key={s.id} className={s.id === sessionId ? 'is-active' : undefined}>
                {renaming?.id === s.id ? (
                  <form className="chat-panel__rename" onSubmit={commitRename}>
                    <input
                      value={renaming.title}
                      aria-label="Conversation name"
                      autoFocus
                      onChange={e => setRenaming({ id: s.id, title: e.target.value })}
                      onBlur={() => setRenaming(null)}
                      onKeyDown={e => { if (e.key === 'Escape') setRenaming(null); }}
                    />
                  </form>
                ) : (
                  <button
                    type="button"
                    className="chat-panel__history-open"
                    onClick={() => { setSessionId(s.id); setPending(null); setShowHistory(false); }}
                  >
                    <span className="chat-panel__history-title">{s.title}</span>
                    <span className="chat-panel__history-meta">
                      {new Date(s.updatedUtc).toLocaleDateString()} · {s.messageCount} message{s.messageCount === 1 ? '' : 's'}
                    </span>
                  </button>
                )}
                <button
                  type="button" className="chat-panel__icon" aria-label={`Rename ${s.title}`}
                  onClick={() => setRenaming({ id: s.id, title: s.title })}
                >
                  <Pencil size={13} />
                </button>
                <button
                  type="button" className="chat-panel__icon chat-panel__icon--danger" aria-label={`Delete ${s.title}`}
                  onClick={() => void deleteSession(s.id, s.title)}
                >
                  <Trash2 size={13} />
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="chat-panel__body" ref={bodyRef}>
        {/* Say what's wrong before the user types a question into a dead box. */}
        {status && !status.ready && (
          <div className="chat-panel__notice" role="status">
            <AlertTriangle size={16} aria-hidden="true" />
            <div>
              <p>{status.reason}</p>

              {/* The picker lives in Settings, once. Duplicating it here would mean
                  two download flows to keep in step for no real gain. */}
              {isAdmin ? (
                <p className="chat-panel__notice-lead">
                  <Link to="/settings?tab=ai" onClick={onClose}>
                    <Download size={13} aria-hidden="true" /> Set up the assistant
                  </Link>
                </p>
              ) : (
                <p className="chat-panel__notice-lead">Ask an administrator to set this up.</p>
              )}
            </div>
          </div>
        )}

        {empty && !statusLoading && status?.ready && (
          <p className="chat-panel__empty">
            Ask a question and Papyra will answer from your own notes
            {status.chatProvider === 'ollama' ? ' — locally, on this machine.' : '.'}
            {' '}Answers come from {providerLabel(status.chatProvider)}
            {status.chatProvider === 'ollama' && `, using ${friendlyModelName(status.chatModel, choices)}`}.
          </p>
        )}

        {messages.map(m => (
          <div key={m.id}>
            {m.role === 'user'
              ? <p className="chat-panel__question">{m.content}</p>
              : <div className="chat-panel__answer">{m.content}</div>}
            {m.role === 'assistant' && m.citations && m.citations.length > 0 && (
              <Sources citations={m.citations} onNavigate={onClose} />
            )}
          </div>
        ))}

        {pending && (
          <>
            <p className="chat-panel__question">{pending.question}</p>
            {(pending.answer || busy) && (
              <div className="chat-panel__answer">
                {pending.answer}
                {busy && <span className="chat-panel__caret" aria-hidden="true" />}
              </div>
            )}
            {pending.citations.length > 0 && <Sources citations={pending.citations} onNavigate={onClose} />}
          </>
        )}

        {error && <p className="chat-panel__error" role="alert">{error}</p>}
      </div>

      <form className="chat-panel__form" onSubmit={ask}>
        <input
          className="chat-panel__input"
          placeholder={status && !status.ready
            ? 'Assistant unavailable'
            : messages.length > 0 ? 'Ask a follow-up…' : 'What did I write about…?'}
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          disabled={status !== undefined && !status.ready}
          aria-label="Your question"
        />
        <button
          type="submit" className="chat-panel__send"
          disabled={busy || !question.trim() || (status !== undefined && !status.ready)}
        >
          <CornerDownLeft size={15} />
        </button>
      </form>
    </aside>
  );
}

/** The notes one answer was based on, as they stood when it was given. */
function Sources({ citations, onNavigate }: { citations: Citation[]; onNavigate: () => void }) {
  return (
    <div className="chat-panel__citations">
      <h3>Sources</h3>
      <ul>
        {citations.map((c) => (
          <li key={c.noteId}>
            <Link to={`/note/${encodeURIComponent(c.noteId)}`} onClick={onNavigate}>
              {c.title || 'Untitled'}
            </Link>
            <span className="chat-panel__score">{Math.round(c.score * 100)}%</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
