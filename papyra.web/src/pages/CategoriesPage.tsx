import { useMemo, useState } from 'react';
import { Plus, Tag, Tags, X, Trash2 } from 'lucide-react';
import { useNotes } from '../hooks/useNotes';
import EmptyState from '../components/EmptyState';
import { useCategories, useCreateCategory, useDeleteCategory } from '../hooks/useCategories';
import NoteGrid from '../components/NoteGrid';
import './CategoriesPage.css';

// Swatch palette reused for category colours (matches the note PalettePicker hues).
const COLORS = ['#dfe9df', '#ecdcd0', '#ece3cf', '#ecd9da', '#d8e3ea', '#e2dcec', '#dde7d4'];

export default function CategoriesPage() {
  const { data: categories, isLoading } = useCategories();
  const { data: notes } = useNotes();
  const create = useCreateCategory();
  const del = useDeleteCategory();

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [color, setColor] = useState<string>(COLORS[0]);

  function toggle(cat: string) {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(cat)) next.delete(cat); else next.add(cat);
      return next;
    });
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    await create.mutateAsync({ name: trimmed, color });
    setName(''); setAdding(false);
  }

  // Notes carrying ANY selected category (case-insensitive tag match).
  const filtered = useMemo(() => {
    if (selected.size === 0) return [];
    const want = new Set([...selected].map(s => s.toLowerCase()));
    return (notes ?? []).filter(n => n.tags.some(t => want.has(t.toLowerCase())));
  }, [notes, selected]);

  return (
    <section className="categories">
      <header className="categories__head">
        <h1 className="page-title categories__title">Categories</h1>
        <button type="button" className="categories__new" onClick={() => setAdding(a => !a)}>
          <Plus size={18} /> New category
        </button>
      </header>

      {adding && (
        <form className="categories__form" onSubmit={submit}>
          <input
            className="categories__input"
            placeholder="Category name"
            value={name}
            autoFocus
            onChange={e => setName(e.target.value)}
          />
          <div className="categories__swatches">
            {COLORS.map(c => (
              <button
                key={c}
                type="button"
                aria-label={`Colour ${c}`}
                className={`categories__swatch${color === c ? ' is-active' : ''}`}
                style={{ background: c }}
                onClick={() => setColor(c)}
              />
            ))}
          </div>
          <button type="submit" className="categories__save" disabled={create.isPending}>
            {create.isPending ? 'Adding…' : 'Add'}
          </button>
        </form>
      )}

      {isLoading && <p className="categories__status">Loading categories…</p>}
      {!isLoading && (categories?.length ?? 0) === 0 && (
        <EmptyState
          icon={Tags}
          title="No categories yet"
          body="Categories group related notes together and give each group a colour, so you can pull up everything on one subject without searching for it."
          hint="Add one above, or type a tag into any note and it will appear here."
        />
      )}

      <div className="categories__grid">
        {categories?.map(cat => (
          <div
            key={cat.name}
            role="button"
            tabIndex={0}
            aria-pressed={selected.has(cat.name)}
            className={`category-card${selected.has(cat.name) ? ' is-selected' : ''}`}
            style={cat.color ? { ['--cat-tint' as string]: cat.color } : undefined}
            onClick={() => toggle(cat.name)}
            onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(cat.name); } }}
          >
            <span className="category-card__icon"><Tag size={16} /></span>
            <span className="category-card__name">{cat.name}</span>
            <span className="category-card__count">{cat.count}</span>
            <button
              type="button"
              className="category-card__del"
              aria-label={`Remove category ${cat.name}`}
              onClick={e => { e.stopPropagation(); void del.mutateAsync(cat.name); setSelected(s => { const n = new Set(s); n.delete(cat.name); return n; }); }}
            >
              <Trash2 size={14} />
            </button>
          </div>
        ))}
      </div>

      {selected.size > 0 && (
        <div className="categories__results">
          <div className="categories__results-head">
            <h2 className="categories__results-title">
              Notes in {[...selected].join(', ')}
            </h2>
            <button type="button" className="categories__clear" onClick={() => setSelected(new Set())}>
              <X size={15} /> Clear
            </button>
          </div>
          <NoteGrid notes={filtered} variant="active" emptyLabel="No notes in these categories." />
        </div>
      )}
    </section>
  );
}
