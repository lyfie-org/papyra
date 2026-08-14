import { describe, expect, it, vi, beforeEach } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import { clearSessionData } from './session';
import * as outbox from './outbox';

// Signing out on a shared machine must leave nothing of the previous user
// behind. The server is partitioned per account, but these client-side stores
// are not, and each one leaked across accounts before clearSessionData existed.
describe('clearSessionData', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('drops cached data belonging to the signed-out user', async () => {
    const qc = new QueryClient();
    qc.setQueryData(['notes'], [{ id: 'private', title: 'Salary review' }]);
    qc.setQueryData(['inbox'], [{ id: 'm1' }]);
    vi.spyOn(outbox, 'clearWrites').mockResolvedValue();

    await clearSessionData(qc);

    // The regression: the next person to sign in on this browser rendered the
    // previous user's notes straight out of this cache.
    expect(qc.getQueryData(['notes'])).toBeUndefined();
    expect(qc.getQueryData(['inbox'])).toBeUndefined();
  });

  it('discards queued offline writes', async () => {
    const qc = new QueryClient();
    const clear = vi.spyOn(outbox, 'clearWrites').mockResolvedValue();

    await clearSessionData(qc);

    // Outbox entries carry a note id but no owner, so replaying them after a
    // different account signs in would write one user's edits into another's
    // vault. Losing unsent edits is the lesser harm.
    expect(clear).toHaveBeenCalledOnce();
  });

  it('tells the service worker to drop its cached API replies', async () => {
    const qc = new QueryClient();
    vi.spyOn(outbox, 'clearWrites').mockResolvedValue();
    const postMessage = vi.fn();
    vi.stubGlobal('navigator', { serviceWorker: { controller: { postMessage } } });

    await clearSessionData(qc);

    expect(postMessage).toHaveBeenCalledWith({ type: 'papyra-clear-data' });
    vi.unstubAllGlobals();
  });

  it('survives a browser with no service worker', async () => {
    const qc = new QueryClient();
    vi.spyOn(outbox, 'clearWrites').mockResolvedValue();
    vi.stubGlobal('navigator', {});

    await expect(clearSessionData(qc)).resolves.toBeUndefined();
    vi.unstubAllGlobals();
  });
});
