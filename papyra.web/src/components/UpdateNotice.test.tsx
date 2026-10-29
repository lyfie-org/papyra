// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import UpdateNotice from './UpdateNotice';

const auth = vi.hoisted(() => ({ role: 'Admin' }));
vi.mock('../hooks/useAuth', () => ({ useAuth: () => ({ user: { role: auth.role } }) }));

const status = (over: Record<string, unknown> = {}) => ({
  enabled: true, current: '1.0.0', available: true, latest: '1.1.0',
  url: 'https://github.com/lyfie-org/papyra/releases/tag/v1.1.0',
  checkedUtc: '2026-10-28T10:00:00Z', sends: { id: '2d1f0c2e-0000-4000-8000-000000000000', version: '1.0.0' }, ...over,
});

let calls: string[] = [];
function serve(body: unknown) {
  calls = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    calls.push(url);
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }));
}

function renderNotice() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<MemoryRouter><QueryClientProvider client={client}><UpdateNotice /></QueryClientProvider></MemoryRouter>);
}

beforeEach(() => { auth.role = 'Admin'; });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('UpdateNotice', () => {
  it('shows an admin a small icon, and the popup it opens says what to do', async () => {
    serve(status());
    renderNotice();
    const icon = await screen.findByRole('button', { name: /Update available: Papyra v1\.1\.0/ });
    expect(icon.getAttribute('aria-haspopup')).toBe('dialog');

    fireEvent.click(icon);
    const dialog = screen.getByRole('dialog', { name: /New version available/ });
    expect(dialog.textContent).toContain('Server version: v1.0.0');
    expect(dialog.textContent).toContain('Latest version: v1.1.0');
    expect(screen.getByRole('link', { name: 'release notes' }).getAttribute('href')).toContain('github.com/lyfie-org/papyra');
    // Plain: no steps, no feature copy, no fine print.
    expect(dialog.textContent).not.toContain('docker');

    fireEvent.click(screen.getByRole('button', { name: 'Acknowledge' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('is not there when this server is up to date', async () => {
    serve(status({ available: false, latest: '1.0.0' }));
    const { container } = renderNotice();
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(container.querySelector('.update-notice')).toBeNull();
  });

  it('never asks, and never shows, for anyone who is not an admin', async () => {
    auth.role = 'User';
    serve(status());
    const { container } = renderNotice();
    await new Promise((r) => setTimeout(r, 50));
    expect(calls).toHaveLength(0);
    expect(container.querySelector('.update-notice')).toBeNull();
  });
});
