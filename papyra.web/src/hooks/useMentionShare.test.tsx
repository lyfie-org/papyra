// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { ConfirmContext, type ConfirmRequest } from '../lib/confirmContext';
import { ToastContext } from '../lib/toastContext';
import { useMentionShare } from './useMentionShare';

// What a mention does to somebody else's access is the whole point of this hook,
// so the tests are about consent: it asks first, it asks once, and a "no" is
// final for the session.

const confirm = vi.fn<(request: ConfirmRequest) => Promise<boolean>>();
const toast = vi.fn();
const fetchMock = vi.fn<(...args: unknown[]) => Promise<Response>>();

function wrapper({ children }: { children: ReactNode }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
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

const ok = () => Promise.resolve({ ok: true, status: 200, json: async () => ({ id: 1 }) } as Response);
const notFound = () => Promise.resolve({ ok: false, status: 404, json: async () => ({ error: 'No such user.' }) } as Response);

function render(noteId = 'n1', secure: boolean | undefined = false) {
  const { result } = renderHook(() => useMentionShare(noteId, secure), { wrapper });
  return result;
}

beforeEach(() => {
  confirm.mockReset().mockResolvedValue(true);
  toast.mockReset();
  fetchMock.mockReset().mockImplementation(ok);
  vi.stubGlobal('fetch', fetchMock);
});

describe('useMentionShare', () => {
  it('asks before sharing, then shares', async () => {
    const share = render();
    await share.current('', 'hello @bea');

    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm.mock.calls[0][0]).toMatchObject({ title: 'Share this note with @bea?' });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/notes/n1/shares');
    expect(JSON.parse(init.body as string)).toEqual({
      kind: 'user', access: 'view', granteeUsername: 'bea',
    });
    expect(toast).toHaveBeenCalledWith('Shared with @bea.');
  });

  it('shares nothing when the author says no', async () => {
    confirm.mockResolvedValue(false);
    const share = render();
    await share.current('', 'hello @bea');

    expect(confirm).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(toast).not.toHaveBeenCalled();
  });

  it('does not ask again about a name it already asked about', async () => {
    confirm.mockResolvedValue(false);
    const share = render();
    // Autosave fires on a debounce, so the same new name arrives repeatedly
    // while the author keeps typing in the same paragraph.
    await share.current('', 'hello @bea');
    await share.current('hello @bea', 'hello @bea, are you there');
    await share.current('', 'hello @bea again');

    expect(confirm).toHaveBeenCalledTimes(1);
  });

  it('asks separately for each new name', async () => {
    const share = render();
    await share.current('', '@bea and @cleo');
    expect(confirm).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('ignores names that were already in the previous revision', async () => {
    const share = render();
    await share.current('hi @bea', 'hi @bea and @cleo');

    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm.mock.calls[0][0]).toMatchObject({ title: 'Share this note with @cleo?' });
  });

  it('says nothing when the name belongs to nobody', async () => {
    // Prose like "@ the shops" or a handle from another service is not an error.
    fetchMock.mockImplementation(notFound);
    const share = render();
    await share.current('', 'meet @nobody at 5');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(toast).not.toHaveBeenCalled();
  });

  it('reports a refusal that is not about an unknown name', async () => {
    fetchMock.mockImplementation(() => Promise.resolve({
      ok: false, status: 400, json: async () => ({ error: 'This note is locked. Unlock it before sharing it.' }),
    } as Response));
    const share = render();
    await share.current('', 'hello @bea');

    expect(toast).toHaveBeenCalledWith('This note is locked. Unlock it before sharing it.');
  });

  it('never offers to share a locked note', async () => {
    const share = render('n1', true);
    await share.current('', 'hello @bea');

    expect(confirm).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
