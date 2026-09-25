import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowRight, Layers, Plus, Tag, Tags, Trash2, X } from 'lucide-react';
import EmptyState from '../components/EmptyState';
import RuleBuilder from '../components/RuleBuilder';
import { useCollections, useDeleteCollection } from '../hooks/useCollections';
import { useCreateTag, useDeleteTag, useTags } from '../hooks/useTags';
import { useNotes } from '../hooks/useNotes';
import { useConfirm } from '../lib/confirmContext';
import { NOTE_SWATCHES } from '../lib/noteColors';
import { MAX_TAG_LENGTH } from '../lib/tags';
import { describeRule, matchesRules, parseRules, type SmartRules } from '../lib/smartCollections';
import './CollectionsPage.css';

const TAG_COLOURS = NOTE_SWATCHES.filter((s) => s.value).map((s) => s.value!);

/**
 * Collections: every way to slice the desk, in one place.
 *
 * Two kinds sit side by side. Smart collections are saved rules that keep
 * themselves up to date; tags are the labels put on notes by hand. Both are
 * doors into the Notes desk rather than pages of their own: opening one lands on
 * Notes, filtered — the same grid, the same drag order, a pill to clear it.
 */
export default function CollectionsPage() {
  const navigate = useNavigate();
  const confirm = useConfirm();
  const { data: notes } = useNotes();
  const { data: collections, isLoading: loadingCollections } = useCollections();
  const { data: tags, isLoading: loadingTags } = useTags();
  const removeCollection = useDeleteCollection();
  const createTag = useCreateTag();
  const deleteTag = useDeleteTag();

  const [building, setBuilding] = useState(false);
  const [newTag, setNewTag] = useState<string | null>(null);
  const [newTagColour, setNewTagColour] = useState<string>(TAG_COLOURS[0]);

  // What the desk would show: live, not archived or trashed, never the inbox.
  const desk = useMemo(
    () => (notes ?? []).filter((n) => !n.trashed && !n.archived && n.kind !== 'inbox'),
    [notes],
  );

  const cards = useMemo(() => (collections ?? []).map((c) => {
    const rules = parseRules(c.rulesJson);
    const matching = rules ? desk.filter((n) => matchesRules(n, rules)) : [];
    return { ...c, rules, count: matching.length, preview: matching.slice(0, 3).map((n) => n.title.trim() || 'Untitled') };
  }), [collections, desk]);

  async function dropCollection(id: number, name: string) {
    if (!(await confirm({
      title: `Delete “${name}”?`,
      body: 'Only the saved rules go. The notes in it stay exactly where they are.',
      confirmLabel: 'Delete collection',
      destructive: true,
    }))) return;
    removeCollection.mutate(id);
  }

  async function dropTag(name: string, count: number) {
    if (!(await confirm({
      title: `Delete the tag “${name}”?`,
      body: count > 0
        ? `It comes off ${count} note${count === 1 ? '' : 's'}. The notes themselves stay, and each one keeps the change in its history.`
        : 'No notes use it yet.',
      confirmLabel: 'Delete tag',
      destructive: true,
    }))) return;
    deleteTag.mutate(name);
  }

  async function addTag(e: React.FormEvent) {
    e.preventDefault();
    const name = (newTag ?? '').trim();
    if (!name) return;
    await createTag.mutateAsync({ name, color: newTagColour });
    setNewTag(null);
  }

  return (
    <section className="collections">
      <h1 className="page-title collections__title">Collections</h1>
      <p className="collections__lede">
        Every way to slice your notes. Smart collections keep themselves up to date; tags are the labels you put
        on notes. Open either and the Notes desk filters to it.
      </p>

      {/* ── Smart collections ─────────────────────────────────────────────── */}
      <div className="collections__section-head">
        <h2 className="collections__subhead"><Layers size={16} /> Smart collections</h2>
        {!building && (
          <button type="button" className="collections__new" onClick={() => setBuilding(true)}>
            <Plus size={15} /> New collection
          </button>
        )}
      </div>

      {building && <RuleBuilder onSaved={() => setBuilding(false)} onCancel={() => setBuilding(false)} />}

      {loadingCollections && <p className="collections__status">Loading collections…</p>}
      {!loadingCollections && cards.length === 0 && !building && (
        <EmptyState
          icon={Layers}
          title="No smart collections yet"
          body="A smart collection is a saved search: “tagged work and pinned”, “coloured Rose”, “mentions invoice”. Set the rules once and it keeps itself up to date as you write."
          action={{ label: 'New collection', onClick: () => setBuilding(true) }}
        />
      )}

      {cards.length > 0 && (
        <ul className="collections__grid">
          {cards.map((c) => (
            <li key={c.id} className="collection-card">
              <button
                type="button"
                className="collection-card__open"
                onClick={() => navigate(`/?collection=${c.id}`)}
                aria-label={`Open ${c.name} on the Notes desk`}
              >
                <span className="collection-card__name">{c.name}</span>
                <span className="collection-card__rules">
                  {c.rules ? <RuleChips rules={c.rules} /> : <em>These rules can’t be read.</em>}
                </span>
                <span className="collection-card__preview">
                  {c.preview.length > 0
                    ? c.preview.map((t, i) => <span key={i} className="collection-card__note">{t}</span>)
                    : <span className="collection-card__none">Nothing matches yet.</span>}
                </span>
                <span className="collection-card__foot">
                  <span className="collection-card__count">{c.count} {c.count === 1 ? 'note' : 'notes'}</span>
                  <ArrowRight size={15} aria-hidden="true" />
                </span>
              </button>
              <button
                type="button"
                className="collection-card__del"
                aria-label={`Delete ${c.name}`}
                onClick={() => void dropCollection(c.id, c.name)}
              >
                <Trash2 size={14} />
              </button>
            </li>
          ))}
        </ul>
      )}

      {/* ── Tags ──────────────────────────────────────────────────────────── */}
      <div className="collections__section-head collections__section-head--tags">
        <h2 className="collections__subhead"><Tags size={16} /> Tags</h2>
        {newTag === null && (
          <button type="button" className="collections__new" onClick={() => setNewTag('')}>
            <Plus size={15} /> New tag
          </button>
        )}
      </div>

      {newTag !== null && (
        <form className="collections__tag-form" onSubmit={addTag}>
          <input
            className="collections__tag-input"
            placeholder="Tag name"
            value={newTag}
            maxLength={MAX_TAG_LENGTH}
            autoFocus
            onChange={(e) => setNewTag(e.target.value)}
            aria-label="New tag name"
          />
          <div className="collections__swatches" role="radiogroup" aria-label="Tag colour">
            {TAG_COLOURS.map((c) => (
              <button
                key={c}
                type="button"
                role="radio"
                aria-checked={newTagColour === c}
                aria-label={NOTE_SWATCHES.find((s) => s.value === c)?.name ?? c}
                className={`collections__swatch${newTagColour === c ? ' is-on' : ''}`}
                style={{ background: c }}
                onClick={() => setNewTagColour(c)}
              />
            ))}
          </div>
          <button type="submit" className="collections__save" disabled={createTag.isPending || !newTag.trim()}>
            {createTag.isPending ? 'Adding…' : 'Add tag'}
          </button>
          <button type="button" className="collections__cancel" aria-label="Cancel" onClick={() => setNewTag(null)}>
            <X size={15} />
          </button>
        </form>
      )}

      {loadingTags && <p className="collections__status">Loading tags…</p>}
      {!loadingTags && (tags?.length ?? 0) === 0 && newTag === null && (
        <EmptyState
          icon={Tags}
          title="No tags yet"
          body="Tags label related notes so you can pull up everything on one subject without searching for it."
          hint="Type a tag under any note’s title, or add one here."
        />
      )}

      {tags && tags.length > 0 && (
        <ul className="collections__tags">
          {tags.map((t) => (
            <li key={t.name} className="tag-pill" style={t.color ? { ['--tag-tint' as string]: t.color } : undefined}>
              <button
                type="button"
                className="tag-pill__open"
                onClick={() => navigate(`/?tag=${encodeURIComponent(t.name)}`)}
                aria-label={`Show notes tagged ${t.name}`}
              >
                <Tag size={13} aria-hidden="true" />
                <span className="tag-pill__name">{t.name}</span>
                <span className="tag-pill__count">{t.count}</span>
              </button>
              <button
                type="button"
                className="tag-pill__del"
                aria-label={`Delete tag ${t.name}`}
                onClick={() => void dropTag(t.name, t.count)}
              >
                <X size={12} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

// A collection's rules as a sentence of chips: colours as swatches, the rest as words.
function RuleChips({ rules }: { rules: SmartRules }) {
  return (
    <>
      {rules.conditions.map((c, i) => (
        <span key={i} className="collection-card__rule">
          {i > 0 && <span className="collection-card__join">{rules.match === 'any' ? 'or' : 'and'}</span>}
          <span className="collection-card__chip">
            {c.field === 'color' && <span className="collection-card__dot" style={{ background: c.value }} aria-hidden="true" />}
            {describeRule(c)}
          </span>
        </span>
      ))}
    </>
  );
}
