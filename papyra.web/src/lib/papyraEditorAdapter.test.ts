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

describe('media', () => {
  const ctx = (over: Record<string, unknown> = {}) => ({
    target: 'a.png', fragment: '', kind: 'image', url: '/api/media/a.png', meta: undefined,
    update: vi.fn(), remove: vi.fn(), ...over,
  });

  it('resolves originals, and thumbnails/posters through the thumb route', () => {
    const a = adapter();
    expect(a.resolveMediaUrl('my photo.png')).toBe('/api/media/my%20photo.png');
    expect(a.resolveMediaUrl('a.png', { variant: 'thumb', width: 300 })).toMatch(/^\/api\/media\/a\.png\/thumb\?w=320/);
    expect(a.resolveMediaUrl('v.mp4', { variant: 'poster', width: 1280 })).toMatch(/^\/api\/media\/v\.mp4\/thumb\?w=1280/);
  });

  it('reports a failed upload once, and a cancel not at all', () => {
    const onUploadError = vi.fn();
    const a = createPapyraEditorAdapter({ noteId: 'n', navigate, queryClient: new QueryClient(), onUploadError });
    a.onUploadError?.(new Error('That file is too large to attach.'), new File(['x'], 'x.png'));
    a.onUploadError?.(new DOMException('Upload cancelled', 'AbortError'), new File(['x'], 'x.png'));
    expect(onUploadError).toHaveBeenCalledTimes(1);
    expect(onUploadError).toHaveBeenCalledWith('That file is too large to attach.');
  });

  it('adds Replace and Download to a selected attachment', () => {
    const items = adapter().mediaToolbarItems!(ctx()).map((i) => i.id);
    expect(items).toEqual(['papyra.replace', 'papyra.download']);
  });

  it('offers Move up/down when it can reach the editor', () => {
    const editor = { getEditorState: () => ({ read: () => [false, true] }) };
    const a = createPapyraEditorAdapter({
      noteId: 'n', navigate, queryClient: new QueryClient(),
      getEditor: () => editor as never,
    });
    const items = a.mediaToolbarItems!(ctx());
    expect(items.map((i) => i.id)).toEqual(['papyra.replace', 'papyra.move-up', 'papyra.move-down', 'papyra.download']);
    expect(items.find((i) => i.id === 'papyra.move-up')!.disabled).toBe(true);
    expect(items.find((i) => i.id === 'papyra.move-down')!.disabled).toBe(false);
  });
});
