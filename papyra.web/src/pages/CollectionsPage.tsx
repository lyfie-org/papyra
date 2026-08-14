import { useState } from 'react';
import { Trash2, Layers } from 'lucide-react';
import NoteGrid from '../components/NoteGrid';
import EmptyState from '../components/EmptyState';
import RuleBuilder from '../components/RuleBuilder';
import { useCollections, useCollectionNotes, useDeleteCollection, type SmartRules } from '../hooks/useCollections';
import './CollectionsPage.css';

function describe(rulesJson: string): string {
  try {
    const rules = JSON.parse(rulesJson) as SmartRules;
    const parts = rules.conditions.map((c) => `${c.field}: ${c.value}`);
    return `${rules.match === 'any' ? 'any' : 'all'} of — ${parts.join(', ')}`;
  } catch {
    return 'invalid rules';
  }
}

// Smart collections: saved AND/OR searches. Selecting one runs its rules live and
// renders the matches in the standard grid — the notes also stay on the main feed.
export default function CollectionsPage() {
  const { data: collections, isLoading } = useCollections();
  const [selected, setSelected] = useState<number | null>(null);
  const { data: notes, isLoading: loadingNotes } = useCollectionNotes(selected);
  const remove = useDeleteCollection();

  const active = collections?.find((c) => c.id === selected) ?? null;

  return (
    <section className="collections">
      <h1 className="page-title collections__title">Smart Collections</h1>
      <p className="collections__hint">
        Saved searches over your notes. A collection is a view — matching notes stay on the main feed.
      </p>

      <RuleBuilder />

      {isLoading && <p className="collections__status">Loading collections…</p>}

      {collections && collections.length > 0 && (
        <ul className="collections__list">
          {collections.map((c) => (
            <li key={c.id}>
              <button
                type="button"
                className={`collections__chip${selected === c.id ? ' is-active' : ''}`}
                onClick={() => setSelected(selected === c.id ? null : c.id)}
              >
                <Layers size={14} /> {c.name}
              </button>
              <button
                type="button"
                className="collections__remove"
                aria-label={`Delete ${c.name}`}
                onClick={() => { if (selected === c.id) setSelected(null); remove.mutate(c.id); }}
              >
                <Trash2 size={13} />
              </button>
            </li>
          ))}
        </ul>
      )}
      {collections && collections.length === 0 && (
        <EmptyState
          icon={Layers}
          title="No collections yet"
          body="A collection is a saved search. Set the rules once — a category, a date range, a word — and it keeps itself up to date as you write, so you never have to run that search again."
          hint="Build your first one using the form above."
        />
      )}

      {active && (
        <>
          <p className="collections__rules">{describe(active.rulesJson)}</p>
          {loadingNotes && <p className="collections__status">Running collection…</p>}
          {!loadingNotes && <NoteGrid notes={notes ?? []} />}
        </>
      )}
    </section>
  );
}
