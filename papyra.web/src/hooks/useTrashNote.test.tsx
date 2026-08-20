// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { ConfirmContext, type ConfirmRequest } from '../lib/confirmContext';
import { ToastContext, type ToastAction } from '../lib/toastContext';
import { useTrashNote } from './useTrashNote';

// This hook exists because deleting a note was written twice and the two copies
// drifted: the editor's never offered an Undo, and it never noticed that Trash
// can be set to remove notes immediately — so at that setting it destroyed a
// note while reporting "moved to Trash". These tests pin both halves.

const confirm = vi.fn<(request: ConfirmRequest) => Promise<boolean>>();
const toast = vi.fn<(message: string, action?: ToastAction) => void>();
const fetchMock = vi.fn<(...args: unknown[]) => Promise<Response>>();

// The retention the settings query answers with for a given test.
let retentionDays = 30;

function wrapper({ children }: { children: ReactNode }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  // Seed the settings cache so the hook reads a settled value rather than
  // undefined, which is its own (deliberately recoverable) case below.
  queryClient.setQueryData(['settings'], { trashRetentionDays: retentionDays });
  return (
    <QueryClientProvider client={queryClient}>
      <ConfirmContext.Provider value={confirm}>
        <ToastContext.Provider value={{ toast }}>
          {children}
        </ToastContext.Provider>
      </ConfirmContext.Provider>
    </QueryClientProvider>
  );
}

const note = { id: 'garden-log', kind: 'note' as const };

function render() {
  const { result } = renderHook(() => useTrashNote(), { wrapper });
  return result;
}

// Only the calls this hook makes about the note. The settings query fetches
// /api/settings on mount, which is the app behaving normally, not a delete.
const calls = () => fetchMock.mock.calls
  .map(([url, init]) => `${(init as RequestInit | undefined)?.method ?? 'GET'} ${url as string}`)
  .filter((c) => !c.endsWith('/api/settings'));

beforeEach(() => {
  retentionDays = 30;
  confirm.mockReset().mockResolvedValue(true);
  toast.mockReset();
  fetchMock.mockReset().mockResolvedValue({ ok: true, status: 200 } as Response);
  vi.stubGlobal('fetch', fetchMock);
});

describe('useTrashNote — the recoverable case', () => {
  it('moves the note to Trash without asking', async () => {
    const trash = render();
    await waitFor(() => expect(typeof trash.current).toBe('function'));

    await expect(trash.current(note)).resolves.toBe(true);
    expect(confirm).not.toHaveBeenCalled();
    expect(calls()).toEqual(['POST /api/notes/garden-log/trash']);
  });

  it('offers an Undo — the half the editor was missing', async () => {
    const trash = render();
    await trash.current(note);

    const [message, action] = toast.mock.calls[0];
    expect(message).toBe('Note moved to Trash.');
    expect(action?.label).toBe('Undo');
  });

  it('and the Undo puts it back', async () => {
    const trash = render();
    await trash.current(note);

    fetchMock.mockClear();
    toast.mock.calls[0][1]!.onClick();
    await waitFor(() => expect(calls()).toEqual(['POST /api/notes/garden-log/untrash']));
  });

  it('calls a to-do list a list', async () => {
    const trash = render();
    await trash.current({ id: 'todo-week', kind: 'todo' });
    expect(toast.mock.calls[0][0]).toBe('List moved to Trash.');
  });

  it('treats a note that is already gone as gone', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 404 } as Response);
    const trash = render();
    await expect(trash.current(note)).resolves.toBe(true);
  });

  it('surfaces a real failure instead of claiming success', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500 } as Response);
    const trash = render();
    await expect(trash.current(note)).rejects.toThrow();
    expect(toast).not.toHaveBeenCalled();
  });
});

describe('useTrashNote — when Trash removes notes immediately', () => {
  beforeEach(() => { retentionDays = 0; });

  it('asks first, because there is nothing to restore from', async () => {
    const trash = render();
    await trash.current(note);

    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm.mock.calls[0][0]).toMatchObject({
      title: 'Delete this note?',
      confirmLabel: 'Delete',
      destructive: true,
    });
    expect(confirm.mock.calls[0][0].body).toContain('cannot be undone');
  });

  it('really deletes it, rather than saying "moved to Trash"', async () => {
    const trash = render();
    await expect(trash.current(note)).resolves.toBe(true);

    expect(calls()).toEqual(['DELETE /api/notes/garden-log']);
    expect(toast).toHaveBeenCalledWith('Note deleted for good.');
  });

  it('offers no Undo it could not honour', async () => {
    const trash = render();
    await trash.current(note);
    expect(toast.mock.calls[0][1]).toBeUndefined();
  });

  it('does nothing at all when the answer is no', async () => {
    confirm.mockResolvedValue(false);
    const trash = render();

    await expect(trash.current(note)).resolves.toBe(false);
    expect(calls()).toEqual([]);
    expect(toast).not.toHaveBeenCalled();
  });
});

describe('useTrashNote — before the setting has loaded', () => {
  it('takes the recoverable path, which is the safe way to be wrong', async () => {
    // No settings in the cache: trashRetentionDays is undefined, not 0.
    function bare({ children }: { children: ReactNode }) {
      const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false, enabled: false } },
      });
      return (
        <QueryClientProvider client={queryClient}>
          <ConfirmContext.Provider value={confirm}>
            <ToastContext.Provider value={{ toast }}>{children}</ToastContext.Provider>
          </ConfirmContext.Provider>
        </QueryClientProvider>
      );
    }
    const { result } = renderHook(() => useTrashNote(), { wrapper: bare });
    await result.current(note);

    expect(calls()).toEqual(['POST /api/notes/garden-log/trash']);
    expect(toast.mock.calls[0][1]?.label).toBe('Undo');
  });
});
