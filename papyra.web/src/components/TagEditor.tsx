import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { useCreateTag, useTags } from '../hooks/useTags';
import { MAX_TAGS_PER_NOTE, MAX_TAG_LENGTH, tagProblem } from '../lib/tags';

// Inline tag editor for the open note. Adding a tag that doesn't exist yet
// registers it too, so it appears under Collections → Tags straight away.
export default function TagEditor({
  tags: saved, onChange,
}: { tags: string[]; onChange: (tags: string[]) => void | Promise<void> }) {
  const { data: all } = useTags();
  // The list being edited. Held here (and in a ref, so two quick adds see each
  // other before a re-render) while saves are in flight; only when none are does
  // it take the saved list back — a refetch mid-edit would otherwise restore an
  // older list and drop what was just typed.
  const [tags, setTags] = useState(saved);
  const working = useRef(saved);
  const pending = useRef(0);
  useEffect(() => {
    if (pending.current === 0) { working.current = saved; setTags(saved); }
  }, [saved]);
  const commit = (next: string[]) => {
    working.current = next;
    setTags(next);
    pending.current++;
    void Promise.resolve(onChange(next)).finally(() => { pending.current--; });
  };
  const create = useCreateTag();
  const [input, setInput] = useState('');
  const [problem, setProblem] = useState<string | null>(null);

  const lower = new Set(tags.map(t => t.toLowerCase()));
  const suggestions = (all ?? []).filter(c => !lower.has(c.name.toLowerCase()));
  const full = tags.length >= MAX_TAGS_PER_NOTE;

  async function add(raw: string) {
    const name = raw.trim();
    const current = working.current;
    const why = tagProblem(name, current);
    if (why) { setProblem(why); return; }
    setInput('');
    setProblem(null);
    if (!name || current.some(t => t.toLowerCase() === name.toLowerCase())) return;
    commit([...current, name]);
    if (!(all ?? []).some(c => c.name.toLowerCase() === name.toLowerCase())) {
      try { await create.mutateAsync({ name }); } catch { /* the tag still lands on the note */ }
    }
  }

  return (
    <div className="note-cats">
      {tags.map(t => (
        <span className="note-cats__chip" key={t}>
          {t}
          <button type="button" aria-label={`Remove tag ${t}`} onClick={() => { setProblem(null); commit(working.current.filter(x => x !== t)); }}>
            <X size={12} />
          </button>
        </span>
      ))}
      <input
        list="note-tag-suggestions"
        className="note-cats__input"
        placeholder={full ? `${MAX_TAGS_PER_NOTE} tags max` : 'Add tag…'}
        aria-label="Add tag"
        value={input}
        maxLength={MAX_TAG_LENGTH}
        disabled={full}
        onChange={e => { setInput(e.target.value); setProblem(null); }}
        onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); void add(input); } }}
        onBlur={() => { if (input.trim()) void add(input); }}
      />
      <datalist id="note-tag-suggestions">
        {suggestions.map(c => <option key={c.name} value={c.name} />)}
      </datalist>
      {problem && <span className="note-cats__problem" role="alert">{problem}</span>}
    </div>
  );
}
