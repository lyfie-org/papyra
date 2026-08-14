import { useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { X, Sparkles, CornerDownLeft, Download, AlertTriangle } from 'lucide-react';
import { useAiStatus, useAiModels, usePullModel, type PullProgress } from '../hooks/useAi';
import { useAuth } from '../hooks/useAuth';
import './ChatPanel.css';

interface Citation {
  noteId: string;
  title: string;
  snippet: string;
  score: number;
}

// Ask-your-notes side panel. Streams the answer over NDJSON and shows the notes it
// was grounded in, each linking back to the source.
//
// The panel opens by asking the server whether the assistant can actually answer.
// It used to just return nothing when no model was installed, which read as a
// broken feature; now it says what's wrong and — for an admin on a machine running
// Ollama — offers to download a model right here.
export default function ChatPanel({ onClose }: { onClose: () => void }) {
  const [question, setQuestion] = useState('');
  const [asked, setAsked] = useState<string | null>(null);
  const [answer, setAnswer] = useState('');
  const [citations, setCitations] = useState<Citation[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const answerRef = useRef<HTMLDivElement | null>(null);

  const { user } = useAuth();
  const isAdmin = user?.role === 'Admin';
  const { data: status, isLoading: statusLoading, refetch: refetchStatus } = useAiStatus();
  const offerDownload = status !== undefined && !status.ready && status.canPull;
  const { data: choices } = useAiModels(offerDownload && isAdmin);

  const [pulling, setPulling] = useState<string | null>(null);
  const [progress, setProgress] = useState<PullProgress | null>(null);
  const pull = usePullModel(setProgress);

  function startPull(model: string) {
    setPulling(model);
    setProgress(null);
    setError(null);
    pull.mutate(model, {
      onError: (e) => setError((e as Error).message),
      onSettled: () => { setPulling(null); setProgress(null); void refetchStatus(); },
    });
  }

  async function ask(e: React.FormEvent) {
    e.preventDefault();
    const q = question.trim();
    if (!q || busy) return;

    setBusy(true);
    setError(null);
    setAnswer('');
    setCitations([]);
    setAsked(q);
    setQuestion('');

    try {
      const res = await fetch('/api/ai/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: q }),
      });
      if (!res.ok || !res.body) throw new Error('Could not reach the assistant.');

      // NDJSON: citations first, then a token frame per fragment, then done.
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? ''; // keep the partial line for the next chunk
        for (const line of lines) {
          if (!line.trim()) continue;
          const frame = JSON.parse(line);
          if (frame.type === 'citations') setCitations(frame.citations ?? []);
          else if (frame.type === 'token') {
            setAnswer((a) => a + frame.value);
            answerRef.current?.scrollTo({ top: answerRef.current.scrollHeight });
          } else if (frame.type === 'done' && frame.error) setError(frame.error);
        }
      }
    } catch {
      setError('Could not reach the assistant.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <aside className="chat-panel" aria-label="Ask your notes">
      <header className="chat-panel__head">
        <h2 className="chat-panel__title"><Sparkles size={16} /> Ask your notes</h2>
        <button type="button" className="chat-panel__close" aria-label="Close assistant" onClick={onClose}>
          <X size={16} />
        </button>
      </header>

      <div className="chat-panel__body" ref={answerRef}>
        {/* Say what's wrong before the user types a question into a dead box. */}
        {status && !status.ready && (
          <div className="chat-panel__notice" role="status">
            <AlertTriangle size={16} aria-hidden="true" />
            <div>
              <p>{status.reason}</p>

              {offerDownload && isAdmin && choices && (
                <>
                  <p className="chat-panel__notice-lead">Download a model to switch it on:</p>
                  <ul className="chat-panel__models">
                    {choices.map(c => (
                      <li key={c.model}>
                        <button
                          type="button" className="chat-panel__model"
                          disabled={pulling !== null}
                          onClick={() => startPull(c.model)}
                        >
                          <Download size={14} aria-hidden="true" />
                          <span className="chat-panel__model-tier">{c.tier}</span>
                          <span className="chat-panel__model-size">{c.size}</span>
                          <span className="chat-panel__model-blurb">{c.blurb}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                  {pulling && (
                    <p className="chat-panel__progress">
                      Downloading {pulling}
                      {progress && progress.total > 0
                        ? ` — ${Math.round((progress.completed / progress.total) * 100)}%`
                        : '…'}
                      <br />
                      <span className="chat-panel__progress-note">
                        This can take a while. You can keep working; leaving this panel won’t stop it.
                      </span>
                    </p>
                  )}
                </>
              )}

              {offerDownload && !isAdmin && (
                <p className="chat-panel__notice-lead">Ask an administrator to install a model.</p>
              )}

              {isAdmin && !status.canPull && (
                <p className="chat-panel__notice-lead">
                  <Link to="/settings?tab=ai" onClick={onClose}>Configure the assistant in Settings → AI</Link>
                </p>
              )}
            </div>
          </div>
        )}

        {asked === null && !statusLoading && status?.ready && (
          <p className="chat-panel__empty">
            Ask a question and Papyra will answer from your own notes
            {status.chatProvider === 'ollama' ? ' — locally, on this machine.' : '.'}
          </p>
        )}

        {asked !== null && <p className="chat-panel__question">{asked}</p>}

        {error && <p className="chat-panel__error" role="alert">{error}</p>}

        {(answer || busy) && (
          <div className="chat-panel__answer">
            {answer}
            {busy && <span className="chat-panel__caret" aria-hidden="true" />}
          </div>
        )}

        {citations.length > 0 && (
          <div className="chat-panel__citations">
            <h3>Sources</h3>
            <ul>
              {citations.map((c) => (
                <li key={c.noteId}>
                  <Link to={`/note/${encodeURIComponent(c.noteId)}`} onClick={onClose}>
                    {c.title || 'Untitled'}
                  </Link>
                  <span className="chat-panel__score">{Math.round(c.score * 100)}%</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      <form className="chat-panel__form" onSubmit={ask}>
        <input
          className="chat-panel__input"
          placeholder={status && !status.ready ? 'Assistant unavailable' : 'What did I write about…?'}
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
