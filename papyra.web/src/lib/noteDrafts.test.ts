// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { createDraft, discardDraft, patchDraft, retainDraft, useDraft } from './noteDrafts';

describe('noteDrafts', () => {
  it('holds a new note locally, with no server revision', () => {
    const id = createDraft();
    const { result } = renderHook(() => useDraft(id));
    expect(result.current).toMatchObject({ id, title: '', body: '', kind: 'note', updated: '' });
    act(() => discardDraft(id));
  });

  it('seeds a to-do list with its first checkbox', () => {
    const id = createDraft('todo', '- [ ] ');
    const { result } = renderHook(() => useDraft(id));
    expect(result.current).toMatchObject({ kind: 'todo', body: '- [ ] ' });
    act(() => discardDraft(id));
  });

  it('shows a pin or colour picked before the first save', () => {
    const id = createDraft();
    const { result } = renderHook(() => useDraft(id));
    act(() => patchDraft(id, { pinned: true, color: '#e8d5c4' }));
    expect(result.current).toMatchObject({ pinned: true, color: '#e8d5c4' });
    act(() => discardDraft(id));
  });

  it('forgets a discarded draft', () => {
    const id = createDraft();
    const { result } = renderHook(() => useDraft(id));
    act(() => discardDraft(id));
    expect(result.current).toBeUndefined();
  });
});

describe('retainDraft', () => {
  it('survives a remount and drops once the last holder lets go', async () => {
    const id = createDraft();
    const { result } = renderHook(() => useDraft(id));
    const release = retainDraft(id);
    release();                    // StrictMode's simulated unmount…
    const again = retainDraft(id); // …and immediate remount.
    await act(() => new Promise((r) => setTimeout(r, 5)));
    expect(result.current?.id).toBe(id);

    again();
    await act(() => new Promise((r) => setTimeout(r, 5)));
    expect(result.current).toBeUndefined();
  });
});
