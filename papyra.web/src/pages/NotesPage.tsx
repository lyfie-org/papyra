import { useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { Plus, UploadCloud } from 'lucide-react';
import DraggableNoteGrid from '../components/DraggableNoteGrid';
import NotesFilterBar, { type NotesScope } from '../components/NotesFilterBar';
import SharedNoteModal from '../components/SharedNoteModal';
import { useIncomingShares } from '../hooks/useShares';
import ConflictResolver from '../components/ConflictResolver';
import FirstRun from '../components/FirstRun';
import { useNotes } from '../hooks/useNotes';
import { useConflicts, type Conflict } from '../hooks/useConflicts';
import { useCollections } from '../hooks/useCollections';
import { matchesRules, parseRules } from '../lib/smartCollections';
import { createDraft } from '../lib/noteDrafts';
import './NotesPage.css';
import LoadingBar from '../components/LoadingBar';
import { fetchWithProgress } from '../lib/progress';

export default function NotesPage() {
  const { data: notes, isLoading, isError } = useNotes();
  const { data: conflicts } = useConflicts();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [resolving, setResolving] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [importMsg, setImportMsg] = useState<string | null>(null);
  const { data: collections } = useCollections();
  // Desk filters (see NotesFilterBar) live in the URL: Collections links straight
  // to "notes tagged X" or "notes in collection Y", a filtered desk survives a
  // reload, and an open note keeps the filtered desk behind it (the editor now
  // opens over whatever page you came from, not as a child of this one).
  const [params, setParams] = useSearchParams();
  const scopeParam = params.get('scope');
  const scope: NotesScope = scopeParam === 'pinned' || scopeParam === 'shared' ? scopeParam : 'all';
  // Notes other people shared with you sit on the desk with your own; `?open=`
  // opens one over it (cards, the bell and old /shared-with-me links use it).
  const { data: incoming } = useIncomingShares();
  const openShare = Number(params.get('open')) || null;
  const selectedTags = useMemo(() => params.getAll('tag'), [params]);
  const collectionId = Number(params.get('collection')) || null;
  const setFilter = (mutate: (p: URLSearchParams) => void) => {
    const next = new URLSearchParams(params);
    mutate(next);
    setParams(next, { replace: true });
  };
  const setScope = (v: NotesScope) => setFilter((p) => { if (v === 'all') p.delete('scope'); else p.set('scope', v); });
  const setSelectedTags = (tags: string[]) => setFilter((p) => { p.delete('tag'); for (const t of tags) p.append('tag', t); });
  const setCollection = (id: number | null) => setFilter((p) => { if (id === null) p.delete('collection'); else p.set('collection', String(id)); });

  const activeCollection = collections?.find((c) => c.id === collectionId) ?? null;
  const activeRules = useMemo(() => (activeCollection ? parseRules(activeCollection.rulesJson) : null), [activeCollection]);

  // Every tag in the vault, for the tag dropdown. Built from the notes the
  // desk can actually show, so a tag that only exists on an archived or trashed
  // note never offers a filter that yields nothing.
  const allTags = useMemo(() => {
    const seen = new Set<string>();
    for (const n of notes ?? []) {
      if (n.trashed || n.archived || n.kind === 'todo' || n.kind === 'inbox') continue;
      for (const t of n.tags ?? []) seen.add(t);
    }
    return [...seen].sort((a, b) => a.localeCompare(b));
  }, [notes]);

  const visibleNotes = useMemo(() => {
    let list = notes ?? [];
    if (scope === 'shared') return [];
    if (scope === 'pinned') list = list.filter((n) => n.pinned);
    // Any selected tag matches — intersecting them would empty the grid almost
    // every time, since notes rarely carry several tags at once.
    if (selectedTags.length > 0) {
      const want = new Set(selectedTags.map((t) => t.toLowerCase()));
      list = list.filter((n) => (n.tags ?? []).some((t) => want.has(t.toLowerCase())));
    }
    // A smart collection is evaluated here, over the live notes, so it follows
    // every edit (tag added, colour changed, pinned) without a refetch.
    if (activeRules) list = list.filter((n) => matchesRules(n, activeRules));
    return list;
  }, [notes, scope, selectedTags, activeRules]);

  // Shared notes show under All and under Shared with me — and under Pinned
  // once you pin one (your own pin). Tags and collections are the owner's, so
  // those filters narrow to your own notes.
  const visibleShared = useMemo(() => {
    if (selectedTags.length > 0 || activeRules) return [];
    const list = incoming ?? [];
    return scope === 'pinned' ? list.filter((s) => s.pinned) : list;
  }, [scope, selectedTags, activeRules, incoming]);

  // A genuinely empty vault (not just an empty filter or an all-archived one)
  // gets the first-run explainer instead of the grid.
  const isFirstRun = scope === 'all' && selectedTags.length === 0 && collectionId === null
    && (notes ?? []).every(n => n.trashed) && (incoming?.length ?? 0) === 0;

  // Quick-import: drop .md/.txt onto the grid → new notes (native DnD, no lib).
  async function importFiles(fileList: FileList) {
    const files = [...fileList].filter((f) => /\.(md|txt)$/i.test(f.name));
    if (files.length === 0) { setImportMsg('Only .md and .txt files can be imported.'); return; }
    setImportMsg('Importing…');
    const form = new FormData();
    files.forEach((f) => form.append('files', f));
    let res: Response;
    try {
      res = await fetchWithProgress('/api/import/quick', { method: 'POST', body: form });
    } catch {
      // Import needs the server: the files are on the user's disk already, and
      // queueing a multipart upload in the outbox would be a different feature.
      setImportMsg('Can’t import while offline — reconnect and drop them again.');
      return;
    }
    const data = await res.json().catch(() => null);
    if (!res.ok) { setImportMsg('Import failed.'); return; }

    await queryClient.invalidateQueries({ queryKey: ['notes'] });
    const n = data?.imported?.length ?? 0;
    // The server also reports what it refused (wrong type, empty, over the size
    // cap) — saying "Imported 0 notes" and nothing else just looks broken.
    const skipped: Array<{ file: string; reason: string }> = data?.skipped ?? [];
    const head = `Imported ${n} note${n === 1 ? '' : 's'}.`;
    setImportMsg(skipped.length
      ? `${head} Skipped ${skipped.length}: ${skipped[0].reason}`
      : head);
  }

  // Group conflicts under the note they shadow so each card can flag its own.
  const conflictsByParent = useMemo(() => {
    const map = new Map<string, Conflict[]>();
    for (const c of conflicts ?? []) {
      const list = map.get(c.parentId);
      if (list) list.push(c);
      else map.set(c.parentId, [c]);
    }
    return map;
  }, [conflicts]);

  // Open a local draft; the first change saves it (see lib/noteDrafts), so a
  // note opened and closed untouched never reaches the disk.
  function createNote() {
    navigate(`/note/${createDraft()}`);
  }

  return (
    <section
      className="notes-page"
      onDragOver={(e) => { e.preventDefault(); if (!dragging) setDragging(true); }}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragging(false); }}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        if (e.dataTransfer.files.length) void importFiles(e.dataTransfer.files);
      }}
    >
      {/* Filters and New note share one row, so the grid starts right under them. */}
      <header className="notes-page__head">
        {!isLoading && !isError && !isFirstRun && (
          <NotesFilterBar
            scope={scope}
            onScopeChange={setScope}
            allTags={allTags}
            selectedTags={selectedTags}
            onSelectedTagsChange={setSelectedTags}
            collections={collections ?? []}
            selectedCollection={collectionId}
            onCollectionChange={setCollection}
            hasShared={(incoming?.length ?? 0) > 0}
          />
        )}
        {importMsg && <span className="notes-page__import-msg">{importMsg}</span>}
        <button type="button" className="notes-page__new" onClick={createNote}>
          <Plus size={18} />
          New note
        </button>
      </header>

      {dragging && (
        <div className="notes-page__dropzone" aria-hidden="true">
          <UploadCloud size={40} />
          <p>Drop <code>.md</code> or <code>.txt</code> files to import</p>
        </div>
      )}

      {isLoading && <LoadingBar label="Loading notes" />}
      {isError && <p className="notes-page__status">Couldn’t reach the server.</p>}
      {/* A brand-new vault gets an explanation, not the word "empty". */}
      {!isLoading && !isError && isFirstRun && <FirstRun onCreate={createNote} />}
      {!isLoading && !isError && !isFirstRun && (
        scope === 'shared' && visibleShared.length === 0
          ? <p className="notes-page__status">Nothing has been shared with you yet.</p>
          : <DraggableNoteGrid
          notes={visibleNotes}
          shared={visibleShared}
          conflictsByParent={conflictsByParent}
          onResolveConflict={setResolving}
          includeTodos={activeRules !== null}
        />
      )}

      {openShare != null && (
        <SharedNoteModal shareId={openShare} onClose={() => setFilter((p) => { p.delete('open'); p.delete('comment'); })} />
      )}

      {resolving && (
        <ConflictResolver conflictId={resolving} onClose={() => setResolving(null)} />
      )}

    </section>
  );
}
