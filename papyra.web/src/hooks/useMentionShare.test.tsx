// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { ShareOfferContext, type ShareOffer, type ShareOfferAnswer } from '../lib/shareOfferContext';
import { ToastContext } from '../lib/toastContext';
import { useMentionShare } from './useMentionShare';

// What a mention does to somebody else's access is the whole point of this hook,
// so the tests are about consent: it asks first, only about real people who
// can't open the note yet, once per name, and shares the whole note at the role
// the author picked.

const offer = vi.fn<(o: ShareOffer) => Promise<ShareOfferAnswer>>();
const toast = vi.fn();
const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();

function wrapper({ children }: { children: ReactNode }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={queryClient}>
      <ShareOfferContext.Provider value={offer}>
        <ToastContext.Provider value={{ toast }}>
          {children}
        </ToastContext.Provider>
      </ShareOfferContext.Provider>
    </QueryClientProvider>
  );
}

const json = (body: unknown, status = 200) =>
  Promise.resolve({ ok: status < 400, status, json: async () => body } as Response);

/** A server with these accounts, and these people already holding the note. */
function server(users: string[], holders: string[] = []) {
  fetchMock.mockImplementation((url, init) => {
    if (url.startsWith('/api/users/search')) {
      const q = decodeURIComponent(url.split('q=')[1]).toLowerCase();
      return json(users.filter(u => u.toLowerCase().startsWith(q)).map(username => ({ username })));
    }
    if (url === '/api/notes/n1/shares' && (!init || init.method !== 'POST'))
      return json(holders.map(grantee => ({ kind: 'user', grantee })));
    return json({ id: 1 });
  });
}

const posts = () => fetchMock.mock.calls
  .filter(([, init]) => init?.method === 'POST')
  .map(([url, init]) => ({ url, body: JSON.parse(init!.body as string) }));

function render(secure: boolean | undefined = false) {
  const { result } = renderHook(() => useMentionShare('n1', secure, () => 'Plan'), { wrapper });
  return result;
}

beforeEach(() => {
  offer.mockReset().mockResolvedValue({ access: 'edit' });
  toast.mockReset();
  fetchMock.mockReset();
  server(['bea', 'cleo']);
  vi.stubGlobal('fetch', fetchMock);
});

describe('useMentionShare', () => {
  it('asks before sharing, then shares the whole note at the chosen role', async () => {
    const share = render();
    await share.current('', 'hello @bea');

    expect(offer).toHaveBeenCalledWith({ names: ['bea'], noteTitle: 'Plan' });
    expect(posts()).toEqual([{
      url: '/api/notes/n1/shares',
      body: { kind: 'user', access: 'edit', granteeUsername: 'bea' },
    }]);
    expect(toast).toHaveBeenCalledWith('Shared with @bea · can edit.');
  });

  it('shares read-only when that is the role picked', async () => {
    offer.mockResolvedValue({ access: 'view' });
    const share = render();
    await share.current('', 'hello @bea');
    expect(posts()[0].body.access).toBe('view');
  });

  it('shares nothing when the author says no', async () => {
    offer.mockResolvedValue(null);
    const share = render();
    await share.current('', 'hello @bea');

    expect(offer).toHaveBeenCalledTimes(1);
    expect(posts()).toEqual([]);
    expect(toast).not.toHaveBeenCalled();
  });

  it('does not ask again about a name it already asked about', async () => {
    offer.mockResolvedValue(null);
    const share = render();
    // Autosave fires on a debounce, so the same new name arrives repeatedly
    // while the author keeps typing in the same paragraph.
    await share.current('', 'hello @bea');
    await share.current('hello @bea', 'hello @bea, are you there');
    await share.current('', 'hello @bea again');

    expect(offer).toHaveBeenCalledTimes(1);
  });

  it('asks about several new names in one dialog', async () => {
    const share = render();
    await share.current('', '@bea and @cleo');
    expect(offer).toHaveBeenCalledTimes(1);
    expect(offer.mock.calls[0][0].names).toEqual(['bea', 'cleo']);
    expect(posts()).toHaveLength(2);
  });

  it('ignores names that were already in the previous revision', async () => {
    const share = render();
    await share.current('hi @bea', 'hi @bea and @cleo');
    expect(offer.mock.calls[0][0].names).toEqual(['cleo']);
  });

  it('does not offer people who can already open the note', async () => {
    server(['bea', 'cleo'], ['bea']);
    const share = render();
    await share.current('', '@bea and @cleo');
    expect(offer.mock.calls[0][0].names).toEqual(['cleo']);
  });

  it('says nothing when the name belongs to nobody', async () => {
    // Prose like "@ the shops" or a handle from another service is not an error.
    const share = render();
    await share.current('', 'meet @nobody at 5');

    expect(offer).not.toHaveBeenCalled();
    expect(posts()).toEqual([]);
    expect(toast).not.toHaveBeenCalled();
  });

  it('reports a refusal from the server', async () => {
    fetchMock.mockImplementation((url, init) => {
      if (url.startsWith('/api/users/search')) return json([{ username: 'bea' }]);
      if (init?.method === 'POST') return json({ error: 'This note is locked. Unlock it before sharing it.' }, 400);
      return json([]);
    });
    const share = render();
    await share.current('', 'hello @bea');

    expect(toast).toHaveBeenCalledWith('This note is locked. Unlock it before sharing it.');
  });

  it('never offers to share a locked note', async () => {
    const share = render(true);
    await share.current('', 'hello @bea');

    expect(offer).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
