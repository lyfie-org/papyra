// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import ErrorBoundary from './ErrorBoundary';
import ErrorPanel from './ErrorPanel';
import ServerErrorNotices from './ServerErrorNotices';
import { ToastProvider } from './ToastProvider';
import { installServerErrorWatch } from '../lib/errorReport';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

function Bomb({ armed }: { armed: boolean }) {
  if (armed) throw new TypeError('cannot read "title" of undefined');
  return <p>fine</p>;
}

describe('ErrorBoundary', () => {
  it('shows the crash with its trace, and recovers on reset or navigation', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    function Host() {
      const [page, setPage] = useState('a');
      const [armed, setArmed] = useState(true);
      return (
        <>
          <button onClick={() => setPage('b')}>navigate</button>
          <button onClick={() => setArmed(false)}>fix</button>
          <ErrorBoundary resetKey={page} fallback={(info, reset) => (
            <ErrorPanel info={info} variant="inline" actions={[{ label: 'Try again', onClick: reset }]} />
          )}>
            <Bomb armed={armed && page === 'a'} />
          </ErrorBoundary>
        </>
      );
    }
    render(<Host />);
    expect(screen.getByRole('alert').textContent).toContain('Something went wrong');
    expect(screen.getByText(/cannot read "title" of undefined/)).toBeTruthy();
    expect(screen.getByText('Copy error details')).toBeTruthy();

    // Still broken → still the panel; fixed → Try again renders it.
    fireEvent.click(screen.getByText('fix'));
    expect(screen.queryByText('fine')).toBeNull();
    fireEvent.click(screen.getByText('Try again'));
    expect(screen.getByText('fine')).toBeTruthy();
  });

  it('clears itself when the resetKey changes', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    function Host() {
      const [page, setPage] = useState('a');
      return (
        <>
          <button onClick={() => setPage('b')}>navigate</button>
          <ErrorBoundary resetKey={page} fallback={() => <p>broken</p>}>
            <Bomb armed={page === 'a'} />
          </ErrorBoundary>
        </>
      );
    }
    render(<Host />);
    expect(screen.getByText('broken')).toBeTruthy();
    fireEvent.click(screen.getByText('navigate'));
    expect(screen.getByText('fine')).toBeTruthy();
  });
});

describe('ErrorPanel', () => {
  it('copies a report someone can send', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    render(<ErrorPanel info={{ title: 'Boom', message: 'm', errorId: 'ABCD-EFGH', stack: 'at X' }} />);
    expect(screen.getByText('ABCD-EFGH')).toBeTruthy();
    await act(async () => { fireEvent.click(screen.getByText('Copy error details')); });
    expect(writeText.mock.calls[0][0]).toMatch(/^Papyra error ABCD-EFGH: Boom/);
    expect(screen.getByText('Copied')).toBeTruthy();
  });

  it('offers no copy button when there is nothing to report (a 404)', () => {
    render(<ErrorPanel info={{ title: 'Gone', message: 'm' }} code="404" />);
    expect(screen.queryByText('Copy error details')).toBeNull();
  });
});

describe('ServerErrorNotices', () => {
  it('turns any server 500 into one toast with its details, and ignores other failures', async () => {
    const responses = [
      new Response(JSON.stringify({ error: 'x', code: 'server_error', errorId: 'WXYZ-2345', detail: { stack: 'trace!', method: 'GET', path: '/api/a' } }),
        { status: 500, headers: { 'content-type': 'application/json' } }),
      new Response(JSON.stringify({ error: 'x', code: 'server_error', errorId: 'WXYZ-9999' }),
        { status: 500, headers: { 'content-type': 'application/json' } }),
      new Response(JSON.stringify({ error: 'nope' }), { status: 400, headers: { 'content-type': 'application/json' } }),
    ];
    window.fetch = vi.fn(async () => responses.shift()!) as typeof fetch;
    installServerErrorWatch();
    render(<ToastProvider><ServerErrorNotices /></ToastProvider>);

    const first = await fetch('/api/a');
    expect(first.status).toBe(500);
    expect(await first.json()).toMatchObject({ errorId: 'WXYZ-2345' }); // the caller still reads its body
    await waitFor(() => expect(screen.getByText(/ref WXYZ-2345/)).toBeTruthy());
    // A burst collapses into the first toast.
    await fetch('/api/b');
    await fetch('/api/c');
    await new Promise(r => setTimeout(r, 20));
    expect(screen.queryByText(/WXYZ-9999/)).toBeNull();

    fireEvent.click(screen.getByText('Details'));
    expect(screen.getByRole('dialog', { name: 'Server error details' })).toBeTruthy();
    expect(screen.getByText('trace!')).toBeTruthy();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Server error details' })).toBeNull();
  });
});
