import { useState } from 'react';
import { X } from 'lucide-react';
import { useCategories, useCreateCategory } from '../hooks/useCategories';

// Inline category (tag) editor for the open note. Adding a category that doesn't
// exist yet registers it in the category registry too, so it shows up in the
// Categories tab — the second of the two creation paths.
export default function CategoryEditor({
  tags, onChange,
}: { tags: string[]; onChange: (tags: string[]) => void }) {
  const { data: cats } = useCategories();
  const create = useCreateCategory();
  const [input, setInput] = useState('');

  const lower = new Set(tags.map(t => t.toLowerCase()));
  const suggestions = (cats ?? []).filter(c => !lower.has(c.name.toLowerCase()));

  async function add(raw: string) {
    const name = raw.trim();
    setInput('');
    if (!name || lower.has(name.toLowerCase())) return;
    onChange([...tags, name]);
    // Register the category if it's brand new (the registry adds colour + lets it
    // appear in the Categories tab even before counts catch up).
    if (!(cats ?? []).some(c => c.name.toLowerCase() === name.toLowerCase())) {
      try { await create.mutateAsync({ name }); } catch { /* tag still lands on the note */ }
    }
  }

  return (
    <div className="note-cats">
      {tags.map(t => (
        <span className="note-cats__chip" key={t}>
          {t}
          <button type="button" aria-label={`Remove ${t}`} onClick={() => onChange(tags.filter(x => x !== t))}>
            <X size={12} />
          </button>
        </span>
      ))}
      <input
        list="note-cat-suggestions"
        className="note-cats__input"
        placeholder="Add category…"
        value={input}
        onChange={e => setInput(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); void add(input); } }}
        onBlur={() => { if (input.trim()) void add(input); }}
      />
      <datalist id="note-cat-suggestions">
        {suggestions.map(c => <option key={c.name} value={c.name} />)}
      </datalist>
    </div>
  );
}
