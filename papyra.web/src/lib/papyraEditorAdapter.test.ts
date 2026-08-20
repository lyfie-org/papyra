import { describe, it, expect, vi, beforeEach } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import type { NavigateFunction } from 'react-router-dom';
import type { Note } from '../types/note';
import { createPapyraEditorAdapter } from './papyraEditorAdapter';

// What a `[[link]]` does when it is clicked. Two things went wrong here and both
// were invisible: a link written the way Obsidian writes them — by filename —
// resolved to nothing, and any link that resolved to nothing did nothing at all,
// with no way to tell it apart from a working one until you clicked it.

function note(partial: Partial<Note> & Pick<Note, 'id' | 'title'>): Note {
  return {
    tags: [], color: null, pinned: false, archived: false, kind: 'note',
    trashed: false, updated: '2026-01-01T00:00:00Z', body: '',
    ...partial,
  };
}

const notes: Note[] = [
  note({ id: 'recipe-chai', title: 'Chai, properly' }),
  note({ id: 'garden-log', title: 'Garden log' }),
  note({ id: 'old-idea', title: 'Old idea', trashed: true }),
];

const navigate = vi.fn() as unknown as NavigateFunction;
const onUnresolvedLink = vi.fn();

function adapter(rows: Note[] = notes) {
  const queryClient = new QueryClient();
  queryClient.setQueryData(['notes'], rows);
  return createPapyraEditorAdapter({
    noteId: 'current', navigate, queryClient, onUnresolvedLink,
  });
}

beforeEach(() => {
  vi.mocked(navigate).mockReset();
  onUnresolvedLink.mockReset();
});

describe('openNote', () => {
  it('follows an id the editor already resolved', () => {
    adapter().openNote({ id: 'garden-log', title: 'anything at all' });
    expect(navigate).toHaveBeenCalledWith('/note/garden-log');
  });

  it('follows a title, as it always did', () => {
    adapter().openNote({ title: 'Chai, properly' });
    expect(navigate).toHaveBeenCalledWith('/note/recipe-chai');
  });

  it('follows a filename — the way Obsidian writes a link', () => {
    // This is the whole of the bug: the same note, linked by the name of its
    // file on disk, used to go nowhere.
    adapter().openNote({ title: 'recipe-chai' });
    expect(navigate).toHaveBeenCalledWith('/note/recipe-chai');
    expect(onUnresolvedLink).not.toHaveBeenCalled();
  });

  it('matches a title regardless of case or padding', () => {
    adapter().openNote({ title: '  chai, PROPERLY ' });
    expect(navigate).toHaveBeenCalledWith('/note/recipe-chai');
  });

  it('matches a filename regardless of case', () => {
    adapter().openNote({ title: 'Recipe-Chai' });
    expect(navigate).toHaveBeenCalledWith('/note/recipe-chai');
  });

  it('prefers a title match over a filename that collides with it', () => {
    const rows = [
      note({ id: 'notes', title: 'Something else' }),
      note({ id: 'other', title: 'notes' }),
    ];
    adapter(rows).openNote({ title: 'notes' });
    expect(navigate).toHaveBeenCalledWith('/note/other');
  });

  it('does not reopen a note from the Trash', () => {
    adapter().openNote({ title: 'old-idea' });
    expect(navigate).not.toHaveBeenCalled();
    expect(onUnresolvedLink).toHaveBeenCalledWith('old-idea');
  });

  it('says so when the link names nothing, rather than doing nothing', () => {
    adapter().openNote({ title: 'A note nobody wrote' });
    expect(navigate).not.toHaveBeenCalled();
    expect(onUnresolvedLink).toHaveBeenCalledWith('A note nobody wrote');
  });

  it('reports the target trimmed, so the message reads as written', () => {
    adapter().openNote({ title: '  Nowhere  ' });
    expect(onUnresolvedLink).toHaveBeenCalledWith('Nowhere');
  });

  it('stays quiet for an empty target — there is nothing to report', () => {
    adapter().openNote({ title: '   ' });
    expect(navigate).not.toHaveBeenCalled();
    expect(onUnresolvedLink).not.toHaveBeenCalled();
  });

  it('reports rather than throwing when the notes cache is empty', () => {
    const queryClient = new QueryClient();
    const bare = createPapyraEditorAdapter({
      noteId: 'current', navigate, queryClient, onUnresolvedLink,
    });
    expect(() => bare.openNote({ title: 'Chai, properly' })).not.toThrow();
    expect(onUnresolvedLink).toHaveBeenCalledWith('Chai, properly');
  });
});
