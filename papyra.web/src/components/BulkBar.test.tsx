// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import type { Note } from '../types/note';
import { ConfirmContext, type ConfirmRequest } from '../lib/confirmContext';
import { ToastContext, type ToastAction } from '../lib/toastContext';
import { setSync } from '../lib/syncStatus';
import BulkBar from './BulkBar';
import BulkShareDialog from './BulkShareDialog';

// The bar is judged by what it does to the selection: one request for the lot,
// the grid updated before the server answers, Undo that puts back exactly what
// changed, and nothing destructive without asking when Trash is off.

const confirm = vi.fn<(r: ConfirmRequest) => Promise<boolean>>();
const toast = vi.fn<(m: string, a?: ToastAction) => void>();
const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();
let client: QueryClient;
let retention = 30;

const mk = (id: string, over: Partial<Note> = {}): Note => ({
  id, title: id.toUpperCase(), tags: [], color: null, pinned: false, archived: false,
  kind: 'note', trashed: false, updated: '2026-01-01T00:00:00Z', body: 'b', ...over,
});

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json' },
});

function wrap(ui: ReactNode) {
  return (
    <QueryClientProvider client={client}>
      <ConfirmContext.Provider value={confirm}>
        <ToastContext.Provider value={{ toast }}>{ui}</ToastContext.Provider>
      </ConfirmContext.Provider>
    </QueryClientProvider>
  );
}

function renderBar(notes: Note[], extra: { total?: number; onClear?: () => void; onSelectAll?: () => void } = {}) {
  client.setQueryData(['notes'], notes);
  client.setQueryData(['settings'], { trashRetentionDays: retention });
  const onClear = extra.onClear ?? vi.fn();
  const onSelectAll = extra.onSelectAll ?? vi.fn();
  render(wrap(<BulkBar notes={notes} total={extra.total ?? notes.length} onClear={onClear} onSelectAll={onSelectAll} />));
  return { onClear, onSelectAll, bar: screen.getByRole('toolbar') };
}

const bulkCalls = () => fetchMock.mock.calls
  .filter(([url]) => url === '/api/notes/bulk')
  .map(([, init]) => JSON.parse(String(init?.body)));

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  retention = 30;
  confirm.mockReset().mockResolvedValue(true);
  toast.mockReset();
  setSync({ online: true });
  fetchMock.mockReset().mockImplementation(async (url, init) => {
    if (url === '/api/notes/bulk') {
      const { ids } = JSON.parse(String(init?.body));
      return json({ changed: ids.length, results: ids.map((id: string) => ({ id, status: 'changed' })) });
    }
    if (url === '/api/notes') return json(client.getQueryData(['notes']) ?? []);
    return json({});
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('BulkBar', () => {
  it('says how many are selected and offers Select all only when it would add something', () => {
    renderBar([mk('a'), mk('b')], { total: 5 });
    expect(screen.getByRole('toolbar', { name: '2 notes selected' })).toBeTruthy();
    expect(screen.getByRole('button', { name: /All 5/ })).toBeTruthy();
    cleanup();
    renderBar([mk('a'), mk('b')], { total: 2 });
    expect(screen.queryByRole('button', { name: /All/ })).toBeNull();
  });

  it('pins a mixed selection in one request, updating the grid before the server answers', async () => {
    let release!: () => void;
    fetchMock.mockImplementationOnce(async (_url, init) => {
      await new Promise<void>((r) => { release = r; });
      const { ids } = JSON.parse(String(init?.body));
      return json({ changed: ids.length, results: ids.map((id: string) => ({ id, status: 'changed' })) });
    });
    const { onClear } = renderBar([mk('a', { pinned: true }), mk('b')]);
    fireEvent.click(screen.getByRole('button', { name: 'Pin' }));

    // Optimistic: both pinned in the cache while the request is still out.
    await waitFor(() => expect((client.getQueryData<Note[]>(['notes']) ?? []).every((n) => n.pinned)).toBe(true));
    expect(onClear).toHaveBeenCalled();
    release();
    await waitFor(() => expect(toast).toHaveBeenCalled());
    expect(bulkCalls()).toEqual([{ ids: ['a', 'b'], action: 'pin' }]);
    expect(toast.mock.calls[0][0]).toBe('Pinned 2 notes.');
  });

  it('offers Unpin when everything selected is already pinned', () => {
    renderBar([mk('a', { pinned: true }), mk('b', { pinned: true })]);
    expect(screen.getByRole('button', { name: 'Unpin' })).toBeTruthy();
  });

  it('Undo reverses only the notes that actually changed', async () => {
    fetchMock.mockImplementationOnce(async () => json({
      changed: 1, results: [{ id: 'a', status: 'changed' }, { id: 'b', status: 'unchanged' }],
    }));
    renderBar([mk('a'), mk('b')]);
    fireEvent.click(screen.getByRole('button', { name: 'Archive' }));
    await waitFor(() => expect(toast).toHaveBeenCalled());
    const [, action] = toast.mock.calls[0];
    action!.onClick();
    await waitFor(() => expect(bulkCalls()).toHaveLength(2));
    expect(bulkCalls()[1]).toEqual({ ids: ['a'], action: 'unarchive' });
  });

  it('Delete moves the lot to Trash with Undo when Trash is on — no questions asked', async () => {
    renderBar([mk('a'), mk('b'), mk('c')]);
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(toast).toHaveBeenCalled());
    expect(confirm).not.toHaveBeenCalled();
    expect(bulkCalls()).toEqual([{ ids: ['a', 'b', 'c'], action: 'trash' }]);
    expect(toast.mock.calls[0][0]).toBe('Moved 3 notes to Trash.');
    expect(toast.mock.calls[0][1]?.label).toBe('Undo');
  });

  it('asks once, then deletes for good, when Trash is set to delete immediately', async () => {
    retention = 0;
    renderBar([mk('a'), mk('b')]);
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(toast).toHaveBeenCalled());
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm.mock.calls[0][0].title).toBe('Delete 2 notes?');
    const deletes = fetchMock.mock.calls.filter(([, init]) => init?.method === 'DELETE').map(([url]) => url);
    expect(deletes.sort()).toEqual(['/api/notes/a', '/api/notes/b']);
    expect(toast.mock.calls[0][0]).toBe('Deleted 2 notes for good.');
  });

  it('backing out of that confirmation deletes nothing and keeps the selection', async () => {
    retention = 0;
    confirm.mockResolvedValue(false);
    const { onClear } = renderBar([mk('a')]);
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(confirm).toHaveBeenCalled());
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(false);
    expect(onClear).not.toHaveBeenCalled();
  });

  it('reports a partial hard delete honestly', async () => {
    retention = 0;
    fetchMock.mockImplementation(async (url, init) => {
      if (init?.method === 'DELETE') return new Response(null, { status: url.endsWith('/b') ? 500 : 204 });
      return json([]);
    });
    renderBar([mk('a'), mk('b')]);
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(toast).toHaveBeenCalled());
    expect(toast.mock.calls[0][0]).toBe("Deleted 1 of 2 notes; 1 couldn't be deleted.");
  });

  it('a server refusal is reported and the optimistic change is thrown away', async () => {
    fetchMock.mockImplementationOnce(async () => json({ error: 'Select at most 1000 notes at a time.' }, 400));
    renderBar([mk('a')]);
    fireEvent.click(screen.getByRole('button', { name: 'Pin' }));
    await waitFor(() => expect(toast).toHaveBeenCalled());
    expect(toast.mock.calls[0][0]).toBe("Couldn't pin 1 note: Select at most 1000 notes at a time.");
    // The optimistic pin is marked stale, so the grid re-reads the truth.
    await waitFor(() => expect(client.getQueryState(['notes'])?.isInvalidated).toBe(true));
  });

  it('names missing notes instead of pretending they changed', async () => {
    fetchMock.mockImplementationOnce(async () => json({
      changed: 1, results: [{ id: 'a', status: 'changed' }, { id: 'b', status: 'notFound' }],
    }));
    renderBar([mk('a'), mk('b')]);
    fireEvent.click(screen.getByRole('button', { name: 'Pin' }));
    await waitFor(() => expect(toast).toHaveBeenCalled());
    expect(toast.mock.calls[0][0]).toBe("Pinned 1 note. 1 note couldn't be found.");
  });

  it('calls them lists on the To Do page', async () => {
    renderBar([mk('a', { kind: 'todo' }), mk('b', { kind: 'todo' })]);
    expect(screen.getByRole('toolbar', { name: '2 lists selected' })).toBeTruthy();
  });

  it('disables server actions offline, and says why', () => {
    setSync({ online: false });
    const { bar } = renderBar([mk('a')]);
    for (const name of ['Pin', 'Archive', 'Share', 'Delete']) {
      const btn = within(bar).getByRole('button', { name }) as HTMLButtonElement;
      expect(btn.disabled).toBe(true);
      expect(btn.title).toBe('Needs a connection');
    }
    // Clearing the selection never needs the server.
    expect((within(bar).getByRole('button', { name: 'Clear selection' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('ignores a double-click on an action (one request, not two)', async () => {
    renderBar([mk('a')]);
    const pin = screen.getByRole('button', { name: 'Pin' });
    fireEvent.click(pin);
    fireEvent.click(pin);
    await waitFor(() => expect(toast).toHaveBeenCalled());
    expect(bulkCalls()).toHaveLength(1);
  });
});

describe('BulkShareDialog', () => {
  function renderDialog(notes: Note[], onClose = vi.fn()) {
    render(wrap(<BulkShareDialog notes={notes} onClose={onClose} />));
    return onClose;
  }

  it('warns before sending when some notes are locked', () => {
    renderDialog([mk('a'), mk('s', { secure: true })]);
    expect(screen.getByText('1 locked note will be skipped.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Share 1' })).toBeTruthy();
  });

  it('refuses to send when every note is locked', () => {
    renderDialog([mk('s', { secure: true }), mk('t', { secure: true })]);
    fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'bea' } });
    expect((screen.getByRole('button', { name: /Share/ }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/Every selected note is locked/)).toBeTruthy();
  });

  it('shares the selection with one person and shows what happened', async () => {
    fetchMock.mockImplementation(async (url) => {
      if (url === '/api/shares/bulk') return json({
        grantee: 'bea', shared: 1,
        results: [{ id: 'a', status: 'shared' }, { id: 'b', status: 'alreadyShared' }],
      });
      return json([]);
    });
    const onClose = renderDialog([mk('a'), mk('b')]);
    fireEvent.change(screen.getByLabelText('Username'), { target: { value: '@bea ' } });
    fireEvent.change(screen.getByLabelText('Access'), { target: { value: 'edit' } });
    fireEvent.click(screen.getByRole('button', { name: 'Share' }));

    await screen.findByText('Shared 1 note with bea. 1 note was already shared.');
    const call = fetchMock.mock.calls.find(([url]) => url === '/api/shares/bulk')!;
    // A leading @ and stray spaces are what people type; the server gets the name.
    expect(JSON.parse(String(call[1]?.body))).toEqual({ noteIds: ['a', 'b'], granteeUsername: 'bea', access: 'edit' });
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(onClose).toHaveBeenCalledWith(true);
  });

  it('keeps the form open with the reason when the person does not exist', async () => {
    fetchMock.mockImplementation(async (url) => url === '/api/shares/bulk'
      ? json({ error: 'There\'s no one called “zed” here.' }, 404)
      : json([]));
    const onClose = renderDialog([mk('a')]);
    fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'zed' } });
    fireEvent.click(screen.getByRole('button', { name: 'Share' }));
    expect((await screen.findByRole('alert')).textContent).toBe('There\'s no one called “zed” here.');
    expect(onClose).not.toHaveBeenCalled();
    expect((screen.getByLabelText('Username') as HTMLInputElement).value).toBe('zed');
  });

  it('closing before sharing keeps the selection (nothing was done)', () => {
    const onClose = renderDialog([mk('a')]);
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledWith(false);
  });

  it('does nothing for an empty or whitespace name', () => {
    renderDialog([mk('a')]);
    fireEvent.change(screen.getByLabelText('Username'), { target: { value: '   ' } });
    expect((screen.getByRole('button', { name: 'Share' }) as HTMLButtonElement).disabled).toBe(true);
  });
});
