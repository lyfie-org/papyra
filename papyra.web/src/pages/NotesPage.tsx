import { useMemo, useState } from 'react';
import { Outlet, useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { Plus, UploadCloud } from 'lucide-react';
import DraggableNoteGrid from '../components/DraggableNoteGrid';
import NotesFilterBar, { type NotesScope } from '../components/NotesFilterBar';
import SharedRail from '../components/SharedRail';
import ConflictResolver from '../components/ConflictResolver';
import FirstRun from '../components/FirstRun';
import { useNotes } from '../hooks/useNotes';
import { useConflicts, type Conflict } from '../hooks/useConflicts';
import { putNote } from '../lib/notesApi';
import './NotesPage.css';

export default function NotesPage() {
  const { data: notes, isLoading, isError } = useNotes();
  const { data: conflicts } = useConflicts();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [resolving, setResolving] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [importMsg, setImportMsg] = useState<string | null>(null);
  // Heatmap cell → filter the grid to notes last modified that day (YYYY-MM-DD).
  // Desk filters (see NotesFilterBar). Kept here rather than in the URL: they are
  // a transient way to look at the desk, and putting them in the query string
  // would fight the `/note/:id` child route the editor opens over this page.
  const [scope, setScope] = useState<NotesScope>('all');
  const [selectedTags, setSelectedTags] = useState<string[]>([]);

  // Every tag in the vault, for the category dropdown. Built from the notes the
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
    if (scope === 'pinned') list = list.filter((n) => n.pinned);
    // Any selected tag matches — intersecting them would empty the grid almost
    // every time, since notes rarely carry several tags at once.
    if (selectedTags.length > 0) {
      list = list.filter((n) => (n.tags ?? []).some((t) => selectedTags.includes(t)));
    }
    return list;
  }, [notes, scope, selectedTags]);

  // A genuinely empty vault (not just an empty filter or an all-archived one)
  // gets the first-run explainer instead of the grid.
  const isFirstRun = scope === 'all' && selectedTags.length === 0
    && (notes ?? []).every(n => n.trashed);

  // Quick-import: drop .md/.txt onto the grid → new notes (native DnD, no lib).
  async function importFiles(fileList: FileList) {
    const files = [...fileList].filter((f) => /\.(md|txt)$/i.test(f.name));
    if (files.length === 0) { setImportMsg('Only .md and .txt files can be imported.'); return; }
    setImportMsg('Importing…');
    const form = new FormData();
    files.forEach((f) => form.append('files', f));
    let res: Response;
    try {
      res = await fetch('/api/import/quick', { method: 'POST', body: form });
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

  // Create = PUT a fresh, empty note (the API upserts) then open it. The id is
  // minted client-side; the .md becomes the source of truth on first write.
  async function createNote() {
    const id = crypto.randomUUID();
    await putNote(id, {
      title: '', tags: [], color: null, pinned: false, archived: false, kind: 'note', body: '',
    });
    await queryClient.invalidateQueries({ queryKey: ['notes'] });
    navigate(`/note/${id}`);
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
      <header className="notes-page__head">
        <button type="button" className="notes-page__new" onClick={() => void createNote()}>
          <Plus size={18} />
          New note
        </button>
        {importMsg && <span className="notes-page__import-msg">{importMsg}</span>}
      </header>

      {dragging && (
        <div className="notes-page__dropzone" aria-hidden="true">
          <UploadCloud size={40} />
          <p>Drop <code>.md</code> or <code>.txt</code> files to import</p>
        </div>
      )}

      {!isLoading && !isError && !isFirstRun && (
        <NotesFilterBar
          scope={scope}
          onScopeChange={setScope}
          allTags={allTags}
          selectedTags={selectedTags}
          onSelectedTagsChange={setSelectedTags}
        />
      )}

      {isLoading && <p className="notes-page__status">Loading notes…</p>}
      {isError && <p className="notes-page__status">Couldn’t reach the server.</p>}
      {/* A brand-new vault gets an explanation, not the word "empty". */}
      {!isLoading && !isError && isFirstRun && <FirstRun onCreate={() => void createNote()} />}
      {!isLoading && !isError && !isFirstRun && (
        <div className="notes-page__body">
          <div className="notes-page__main">
            <DraggableNoteGrid
              notes={visibleNotes}
              conflictsByParent={conflictsByParent}
              onResolveConflict={setResolving}
            />
          </div>
          <SharedRail />
        </div>
      )}

      {resolving && (
        <ConflictResolver conflictId={resolving} onClose={() => setResolving(null)} />
      )}

      {/* /note/:id renders the editor modal over this grid. */}
      <Outlet />
    </section>
  );
}
