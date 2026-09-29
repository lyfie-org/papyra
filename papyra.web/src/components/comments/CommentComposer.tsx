import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import Avatar from '../Avatar';
import type { CommentPerson } from '../../hooks/useComments';

const MAX = 4000;

/** The @handle being typed just before the caret, if any. */
function mentionAt(text: string, caret: number): { start: number; query: string } | null {
  const m = /(^|[^\w@])@([A-Za-z0-9_.-]{0,64})$/.exec(text.slice(0, caret));
  return m ? { start: caret - m[2].length - 1, query: m[2].toLowerCase() } : null;
}

/**
 * A comment box: grows with its text, @ opens a list of the people who can see
 * the note, Ctrl/⌘+Enter sends, Escape cancels. Escape is claimed here (and
 * stopped) so it never also closes the note underneath.
 */
export default function CommentComposer({
  people, placeholder, initial = '', submitLabel, busy, autoFocus, onSubmit, onCancel, compact,
}: {
  people: CommentPerson[];
  placeholder: string;
  initial?: string;
  submitLabel: string;
  busy?: boolean;
  autoFocus?: boolean;
  onSubmit: (body: string) => Promise<unknown> | void;
  onCancel?: () => void;
  /** A reply box: one line until focused or typed in. */
  compact?: boolean;
}) {
  const [text, setText] = useState(initial);
  const [mention, setMention] = useState<{ start: number; query: string } | null>(null);
  const [pick, setPick] = useState(0);
  const [focused, setFocused] = useState(!!autoFocus);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    if (!autoFocus) return;
    const el = ref.current;
    el?.focus({ preventScroll: true });
    el?.setSelectionRange(el.value.length, el.value.length);
  }, [autoFocus]);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  }, [text, focused]);

  const matches = mention
    ? people.filter(p => p.username.toLowerCase().startsWith(mention.query) || p.name.toLowerCase().includes(mention.query)).slice(0, 6)
    : [];

  function update(value: string, caret: number) {
    setText(value);
    setError(null);
    setMention(mentionAt(value, caret));
    setPick(0);
  }

  function choose(p: CommentPerson) {
    if (!mention) return;
    const el = ref.current!;
    const caret = el.selectionStart;
    const next = `${text.slice(0, mention.start)}@${p.username} ${text.slice(caret)}`;
    const at = mention.start + p.username.length + 2;
    setText(next);
    setMention(null);
    requestAnimationFrame(() => { el.focus(); el.setSelectionRange(at, at); });
  }

  async function submit() {
    const body = text.trim();
    if (!body || busy) return;
    try {
      await onSubmit(body);
      setText('');
      setMention(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (matches.length > 0) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setPick(i => (i + 1) % matches.length); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setPick(i => (i - 1 + matches.length) % matches.length); return; }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); choose(matches[pick]); return; }
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); e.nativeEvent.stopImmediatePropagation(); setMention(null); return; }
    }
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void submit(); return; }
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      e.nativeEvent.stopImmediatePropagation();
      if (onCancel) onCancel(); else { setText(''); ref.current?.blur(); }
    }
  }

  const open = !compact || focused || text.length > 0;

  return (
    <div className={`comment-composer${open ? ' is-open' : ''}`}>
      <textarea
        ref={ref}
        className="comment-composer__input"
        value={text}
        rows={1}
        maxLength={MAX}
        placeholder={placeholder}
        aria-label={placeholder}
        onChange={(e) => update(e.target.value, e.target.selectionStart)}
        onKeyDown={onKeyDown}
        onFocus={() => setFocused(true)}
        onBlur={() => { setFocused(false); window.setTimeout(() => setMention(null), 150); }}
        onClick={(e) => setMention(mentionAt(text, e.currentTarget.selectionStart))}
      />
      {matches.length > 0 && (
        <ul className="comment-composer__mentions" role="listbox" aria-label="Mention someone">
          {matches.map((p, i) => (
            <li key={p.id} role="option" aria-selected={i === pick}>
              <button type="button" className={i === pick ? 'is-active' : undefined}
                onMouseDown={(e) => { e.preventDefault(); choose(p); }}>
                <Avatar username={p.username} name={p.name} size={20} />
                <span className="comment-composer__mention-name">{p.name}</span>
                <span className="comment-composer__mention-handle">@{p.username}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {error && <p className="comment-composer__error" role="alert">{error}</p>}
      {open && (
        <div className="comment-composer__actions">
          <span className="comment-composer__hint">@ to mention · Ctrl+Enter to send</span>
          {onCancel && <button type="button" className="comment-btn" onClick={onCancel}>Cancel</button>}
          <button type="button" className="comment-btn comment-btn--primary" disabled={!text.trim() || busy}
            onMouseDown={(e) => e.preventDefault()} onClick={() => void submit()}>
            {submitLabel}
          </button>
        </div>
      )}
    </div>
  );
}
