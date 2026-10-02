// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import type { Note } from '../types/note';

// The "modified externally" banner holds autosave: a revision the editor never
// adopted is on disk, and the debounced save used to write the draft straight
// over it — before the person had picked Review or Overwrite with Local, and
// (inside the server's snapshot throttle) with no copy kept in History.

const putNote = vi.fn<(...args: unknown[]) => Promise<'saved' | 'queued'>>();
vi.mock('../lib/notesApi', () => ({ putNote: (...args: unknown[]) => putNote(...args) }));

const { useAutoSave } = await import('./useAutoSave');

const note: Note = {
  id: 'n1', title: 'Plan', body: 'mine', tags: [], color: null, pinned: false, archived: false,
  kind: 'note', trashed: false, secure: false, updated: '2026-10-01T00:00:00Z',
} as Note;

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={new QueryClient()}>{children}</QueryClientProvider>;
}

let draft: { title: string; body: string };
const onOverwrote = vi.fn();

function render() {
  return renderHook(
    () => useAutoSave(note, () => draft, undefined, undefined, undefined, onOverwrote),
    { wrapper },
  );
}

/** The body and force flag of each PUT, in order. */
const writes = () => putNote.mock.calls.map(([, payload, , opts]) => ({
  body: (payload as { body: string }).body,
  force: !!(opts as { forceSnapshot?: boolean } | undefined)?.forceSnapshot,
}));

beforeEach(() => {
  vi.useFakeTimers();
  putNote.mockReset().mockResolvedValue('saved');
  onOverwrote.mockReset();
  draft = { title: 'Plan', body: 'mine' };
});
afterEach(() => vi.useRealTimers());

const type = (result: ReturnType<typeof render>['result'], body: string) => {
  draft = { ...draft, body };
  act(() => result.current.bump());
};

describe('autosave over a revision the editor has not adopted', () => {
  it('saves a plain edit after the debounce', async () => {
    const { result } = render();
    type(result, 'mine, edited');
    await act(() => vi.advanceTimersByTimeAsync(1500));
    expect(writes()).toEqual([{ body: 'mine, edited', force: false }]);
  });

  it('cancels a save already scheduled when the hold starts, and schedules none while held', async () => {
    const { result } = render();
    type(result, 'mine, edited');            // debounce running…
    act(() => result.current.hold(true));    // …when the outside revision arrives
    type(result, 'mine, edited more');
    await act(() => vi.advanceTimersByTimeAsync(60_000));

    expect(putNote).not.toHaveBeenCalled();
    expect(result.current.status).toBe('held');
    expect(result.current.isHeld()).toBe(true);
  });

  it('Overwrite with Local writes the draft and asks the server to archive the held revision', async () => {
    const { result } = render();
    type(result, 'mine, edited');
    act(() => result.current.hold(true));
    await act(() => result.current.flush({ overwrite: true }));

    expect(writes()).toEqual([{ body: 'mine, edited', force: true }]);
    expect(onOverwrote).toHaveBeenCalledOnce();
    expect(result.current.isHeld()).toBe(false);

    // Resolved: later edits autosave as usual, without forcing.
    type(result, 'mine, edited again');
    await act(() => vi.advanceTimersByTimeAsync(1500));
    expect(writes()[1]).toEqual({ body: 'mine, edited again', force: false });
  });

  it('Overwrite with Local still writes when the draft is back to the last save', async () => {
    const { result } = render();
    type(result, 'mine, edited');
    act(() => result.current.hold(true));
    type(result, 'mine');                    // typed it back to what was saved
    await act(() => result.current.flush({ overwrite: true }));
    expect(writes()).toEqual([{ body: 'mine', force: true }]);
  });

  it('adopting the revision (reset) releases the hold without writing', async () => {
    const { result } = render();
    type(result, 'mine, edited');
    act(() => result.current.hold(true));
    draft = { title: 'Plan', body: 'theirs' };
    act(() => result.current.reset(draft));

    expect(putNote).not.toHaveBeenCalled();
    expect(onOverwrote).not.toHaveBeenCalled();
    type(result, 'theirs, edited');
    await act(() => vi.advanceTimersByTimeAsync(1500));
    expect(writes()).toEqual([{ body: 'theirs, edited', force: false }]);
  });

  it('leaving with the banner up saves the draft, archiving the held revision', async () => {
    const { result, unmount } = render();
    type(result, 'mine, edited');
    act(() => result.current.hold(true));
    unmount();
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(writes()).toEqual([{ body: 'mine, edited', force: true }]);
  });
});
