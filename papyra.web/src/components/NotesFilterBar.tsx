import { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, Pin, Tags, X } from 'lucide-react';
import './NotesFilterBar.css';

export type NotesScope = 'all' | 'pinned';

interface Props {
  scope: NotesScope;
  onScopeChange: (scope: NotesScope) => void;
  /** Every tag present in the vault, for the category dropdown. */
  allTags: string[];
  /** Currently selected tags; empty means "no tag filter". */
  selectedTags: string[];
  onSelectedTagsChange: (tags: string[]) => void;
}

/**
 * Filter pills above the notes grid: a scope toggle (All / Pinned) and a
 * multi-select category dropdown. Filtering happens on the desk itself rather
 * than by navigating to a separate page, so the grid — and the drag order the
 * user arranged — stays put while they narrow it down.
 *
 * Selecting several categories widens the result (a note matching any selected
 * tag shows). Intersecting them would produce an empty grid almost every time,
 * since notes rarely carry three tags at once.
 */
export default function NotesFilterBar({
  scope, onScopeChange, allTags, selectedTags, onSelectedTagsChange,
}: Props) {
  const [tagsOpen, setTagsOpen] = useState(false);
  const tagsRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!tagsOpen) return;
    const onDown = (e: MouseEvent) => {
      if (tagsRef.current && !tagsRef.current.contains(e.target as Node)) setTagsOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [tagsOpen]);

  function toggleTag(tag: string) {
    onSelectedTagsChange(
      selectedTags.includes(tag)
        ? selectedTags.filter((t) => t !== tag)
        : [...selectedTags, tag],
    );
  }

  return (
    <div className="notes-filters" role="group" aria-label="Filter notes">
      <button
        type="button"
        className={`notes-filters__pill${scope === 'all' ? ' is-active' : ''}`}
        aria-pressed={scope === 'all'}
        onClick={() => onScopeChange('all')}
      >
        All
      </button>

      <button
        type="button"
        className={`notes-filters__pill${scope === 'pinned' ? ' is-active' : ''}`}
        aria-pressed={scope === 'pinned'}
        onClick={() => onScopeChange('pinned')}
      >
        <Pin size={13} aria-hidden="true" /> Pinned
      </button>

      {allTags.length > 0 && (
        <div className="notes-filters__dropdown" ref={tagsRef}>
          <button
            type="button"
            className={`notes-filters__pill${selectedTags.length > 0 ? ' is-active' : ''}`}
            aria-expanded={tagsOpen}
            aria-haspopup="true"
            onClick={() => setTagsOpen((o) => !o)}
          >
            <Tags size={13} aria-hidden="true" />
            Categories
            {selectedTags.length > 0 && (
              <span className="notes-filters__count">{selectedTags.length}</span>
            )}
            <ChevronDown size={13} aria-hidden="true" />
          </button>

          {tagsOpen && (
            <div className="notes-filters__menu" role="group" aria-label="Filter by category">
              {allTags.map((tag) => {
                const on = selectedTags.includes(tag);
                return (
                  <button
                    key={tag}
                    type="button"
                    role="checkbox"
                    aria-checked={on}
                    className={`notes-filters__option${on ? ' is-on' : ''}`}
                    onClick={() => toggleTag(tag)}
                  >
                    <span className="notes-filters__tick" aria-hidden="true">
                      {on && <Check size={12} />}
                    </span>
                    {tag}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}

      {selectedTags.length > 0 && (
        <button
          type="button"
          className="notes-filters__clear"
          onClick={() => onSelectedTagsChange([])}
        >
          <X size={13} aria-hidden="true" /> Clear categories
        </button>
      )}
    </div>
  );
}
