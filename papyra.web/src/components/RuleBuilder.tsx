import { useState } from 'react';
import { Plus, X } from 'lucide-react';
import { useCreateCollection, type SmartRule, type SmartRules } from '../hooks/useCollections';
import './RuleBuilder.css';

const FIELDS: { id: SmartRule['field']; label: string; placeholder: string }[] = [
  { id: 'tag', label: 'Tag is', placeholder: 'work' },
  { id: 'color', label: 'Color is', placeholder: '#7aaa8a' },
  { id: 'pinned', label: 'Pinned is', placeholder: 'true' },
  { id: 'kind', label: 'Kind is', placeholder: 'note' },
  { id: 'text', label: 'Text contains', placeholder: 'budget' },
];

// Builds an AND/OR rule set and saves it as a smart collection (a saved search —
// matching notes stay on the main feed).
export default function RuleBuilder({ onSaved }: { onSaved?: () => void }) {
  const create = useCreateCollection();
  const [name, setName] = useState('');
  const [match, setMatch] = useState<SmartRules['match']>('all');
  const [conditions, setConditions] = useState<SmartRule[]>([{ field: 'tag', value: '' }]);
  const [error, setError] = useState<string | null>(null);

  function update(i: number, patch: Partial<SmartRule>) {
    setConditions((cs) => cs.map((c, idx) => (idx === i ? { ...c, ...patch } : c)));
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const usable = conditions.filter((c) => c.value.trim().length > 0);
    if (!name.trim()) { setError('Give the collection a name.'); return; }
    if (usable.length === 0) { setError('Add at least one condition with a value.'); return; }
    try {
      await create.mutateAsync({ name: name.trim(), rules: { match, conditions: usable } });
      setName('');
      setConditions([{ field: 'tag', value: '' }]);
      onSaved?.();
    } catch {
      setError('Couldn’t save the collection.');
    }
  }

  return (
    <form className="rule-builder" onSubmit={save}>
      <div className="rule-builder__row">
        <input
          className="rule-builder__name"
          placeholder="Collection name (e.g. Urgent work)"
          value={name}
          onChange={(e) => setName(e.target.value)}
          aria-label="Collection name"
        />
        <select
          className="rule-builder__match"
          value={match}
          onChange={(e) => setMatch(e.target.value as SmartRules['match'])}
          aria-label="Match mode"
        >
          <option value="all">Match all (AND)</option>
          <option value="any">Match any (OR)</option>
        </select>
      </div>

      {conditions.map((c, i) => (
        <div className="rule-builder__row" key={i}>
          <select
            className="rule-builder__field"
            value={c.field}
            onChange={(e) => update(i, { field: e.target.value as SmartRule['field'] })}
            aria-label="Field"
          >
            {FIELDS.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
          </select>
          <input
            className="rule-builder__value"
            placeholder={FIELDS.find((f) => f.id === c.field)?.placeholder}
            value={c.value}
            onChange={(e) => update(i, { value: e.target.value })}
            aria-label="Value"
          />
          {conditions.length > 1 && (
            <button
              type="button"
              className="rule-builder__remove"
              aria-label="Remove condition"
              onClick={() => setConditions((cs) => cs.filter((_, idx) => idx !== i))}
            >
              <X size={14} />
            </button>
          )}
        </div>
      ))}

      <div className="rule-builder__actions">
        <button
          type="button"
          className="rule-builder__add"
          onClick={() => setConditions((cs) => [...cs, { field: 'tag', value: '' }])}
        >
          <Plus size={14} /> Add condition
        </button>
        <button type="submit" className="rule-builder__save" disabled={create.isPending}>
          {create.isPending ? 'Saving…' : 'Save collection'}
        </button>
      </div>
      {error && <p className="rule-builder__error" role="alert">{error}</p>}
    </form>
  );
}
