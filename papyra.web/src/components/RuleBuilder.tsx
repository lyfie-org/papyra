import { useMemo, useState } from 'react';
import { Check, Plus, X } from 'lucide-react';
import { useCreateCollection } from '../hooks/useCollections';
import { useTags } from '../hooks/useTags';
import { useNotes } from '../hooks/useNotes';
import { NOTE_SWATCHES, swatchName } from '../lib/noteColors';
import type { SmartField, SmartRule, SmartRules } from '../lib/smartCollections';
import './RuleBuilder.css';

const FIELDS: { id: SmartField; label: string }[] = [
  { id: 'tag', label: 'Tag is' },
  { id: 'color', label: 'Colour is' },
  { id: 'pinned', label: 'Pinned' },
  { id: 'kind', label: 'Type is' },
  { id: 'text', label: 'Text contains' },
];

/**
 * Builds an AND/OR rule set and saves it as a smart collection (a saved search —
 * matching notes stay on the main feed).
 *
 * Every condition offers the values that actually exist — the tags in use, the
 * colours a note can be, pinned or not, note or to-do — rather than a blank box
 * that asks for a hex code or the word "true". Only "text contains" is typed.
 */
export default function RuleBuilder({ onSaved, onCancel }: { onSaved?: () => void; onCancel?: () => void }) {
  const create = useCreateCollection();
  const { data: tags } = useTags();
  const { data: notes } = useNotes();
  const [name, setName] = useState('');
  const [match, setMatch] = useState<SmartRules['match']>('all');
  const [error, setError] = useState<string | null>(null);

  const tagNames = useMemo(() => (tags ?? []).map((t) => t.name), [tags]);
  // The palette, plus any colour a note carries from elsewhere (an import).
  const colours = useMemo(() => {
    const list = NOTE_SWATCHES.filter((s) => s.value).map((s) => ({ name: s.name, value: s.value! }));
    const known = new Set(list.map((c) => c.value.toLowerCase()));
    for (const n of notes ?? []) {
      if (n.color && !known.has(n.color.toLowerCase())) {
        known.add(n.color.toLowerCase());
        list.push({ name: 'Other', value: n.color });
      }
    }
    return list;
  }, [notes]);

  const initialValue = (field: SmartField): string => {
    switch (field) {
      case 'tag': return tagNames[0] ?? '';
      case 'color': return colours[0]?.value ?? '';
      case 'pinned': return 'true';
      case 'kind': return 'note';
      default: return '';
    }
  };

  const [conditions, setConditions] = useState<SmartRule[]>(() => [{ field: 'tag', value: '' }]);
  // Seed the first tag once the tag list arrives, without clobbering a choice.
  const shown = conditions.map((c) => (c.field === 'tag' && !c.value && tagNames[0] ? { ...c, value: tagNames[0] } : c));

  function update(i: number, patch: Partial<SmartRule>) {
    setConditions(() => shown.map((c, idx) => {
      if (idx !== i) return c;
      const next = { ...c, ...patch };
      if (patch.field && patch.field !== c.field) next.value = initialValue(patch.field);
      return next;
    }));
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const usable = shown.filter((c) => c.value.trim().length > 0);
    if (!name.trim()) { setError('Give the collection a name.'); return; }
    if (usable.length === 0) { setError('Add at least one condition.'); return; }
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
          maxLength={60}
          onChange={(e) => setName(e.target.value)}
          aria-label="Collection name"
          autoFocus
        />
        <div className="rule-builder__seg" role="radiogroup" aria-label="Match">
          {(['all', 'any'] as const).map((m) => (
            <button
              key={m}
              type="button"
              role="radio"
              aria-checked={match === m}
              className={`rule-builder__pill${match === m ? ' is-on' : ''}`}
              onClick={() => setMatch(m)}
            >
              {m === 'all' ? 'Match all' : 'Match any'}
            </button>
          ))}
        </div>
      </div>

      {shown.map((c, i) => (
        <div className="rule-builder__row rule-builder__cond" key={i}>
          <select
            className="rule-builder__field"
            value={c.field}
            onChange={(e) => update(i, { field: e.target.value as SmartField })}
            aria-label="Condition"
          >
            {FIELDS.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
          </select>

          {c.field === 'tag' && (
            tagNames.length > 0 ? (
              <select
                className="rule-builder__value"
                value={c.value}
                onChange={(e) => update(i, { value: e.target.value })}
                aria-label="Tag"
              >
                {tagNames.map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
            ) : (
              <span className="rule-builder__empty">No tags yet — add one to a note first.</span>
            )
          )}

          {c.field === 'color' && (
            <div className="rule-builder__swatches" role="radiogroup" aria-label="Colour">
              {colours.map((col) => {
                const on = c.value.toLowerCase() === col.value.toLowerCase();
                const label = swatchName(col.value) ?? `${col.name} (${col.value})`;
                return (
                  <button
                    key={col.value}
                    type="button"
                    role="radio"
                    aria-checked={on}
                    aria-label={label}
                    title={label}
                    className={`rule-builder__swatch${on ? ' is-on' : ''}`}
                    style={{ background: col.value }}
                    onClick={() => update(i, { value: col.value })}
                  >
                    {on && <Check size={13} aria-hidden="true" />}
                  </button>
                );
              })}
            </div>
          )}

          {(c.field === 'pinned' || c.field === 'kind') && (
            <div className="rule-builder__seg" role="radiogroup" aria-label={c.field === 'pinned' ? 'Pinned' : 'Type'}>
              {(c.field === 'pinned'
                ? [{ v: 'true', l: 'Pinned' }, { v: 'false', l: 'Not pinned' }]
                : [{ v: 'note', l: 'Notes' }, { v: 'todo', l: 'To-do lists' }]
              ).map((o) => (
                <button
                  key={o.v}
                  type="button"
                  role="radio"
                  aria-checked={c.value === o.v}
                  className={`rule-builder__pill${c.value === o.v ? ' is-on' : ''}`}
                  onClick={() => update(i, { value: o.v })}
                >
                  {o.l}
                </button>
              ))}
            </div>
          )}

          {c.field === 'text' && (
            <input
              className="rule-builder__value"
              placeholder="e.g. budget"
              value={c.value}
              onChange={(e) => update(i, { value: e.target.value })}
              aria-label="Text"
            />
          )}

          {shown.length > 1 && (
            <button
              type="button"
              className="rule-builder__remove"
              aria-label="Remove condition"
              onClick={() => setConditions(shown.filter((_, idx) => idx !== i))}
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
          onClick={() => setConditions([...shown, { field: 'tag', value: tagNames[0] ?? '' }])}
        >
          <Plus size={14} /> Add condition
        </button>
        <span className="rule-builder__spacer" />
        {onCancel && (
          <button type="button" className="rule-builder__cancel" onClick={onCancel}>Cancel</button>
        )}
        <button type="submit" className="rule-builder__save" disabled={create.isPending}>
          {create.isPending ? 'Saving…' : 'Save collection'}
        </button>
      </div>
      {error && <p className="rule-builder__error" role="alert">{error}</p>}
    </form>
  );
}
