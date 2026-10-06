// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import SetUpAuthenticatorPage from './SetUpAuthenticatorPage';

// The person just signed in to reach this screen: no password again, and the
// code goes in by itself on the sixth digit.

vi.mock('../components/TotpQr', () => ({ default: () => <div data-testid="qr" /> }));

const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (url: string) =>
    url.endsWith('/begin')
      ? new Response(JSON.stringify({ secret: 'ABCD', uri: 'otpauth://totp/x' }), { status: 200 })
      : new Response('{}', { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function renderPage() {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <SetUpAuthenticatorPage username="bea" />
    </QueryClientProvider>,
  );
}

describe('SetUpAuthenticatorPage', () => {
  it('asks for a code only, never a password', async () => {
    renderPage();
    await screen.findByTestId('qr');
    expect(screen.queryByLabelText(/password/i)).toBeNull();
  });

  it('submits on the sixth digit, without a password', async () => {
    renderPage();
    await screen.findByTestId('qr');

    fireEvent.change(screen.getByLabelText('6-digit code'), { target: { value: '123456' } });

    await waitFor(() => {
      const post = fetchMock.mock.calls.find(([url]) => url === '/api/auth/totp');
      expect(post).toBeTruthy();
      expect(JSON.parse((post![1] as RequestInit).body as string)).toEqual({ secret: 'ABCD', code: '123456' });
    });
  });

  it('clears the code and says why when it is wrong', async () => {
    fetchMock.mockImplementation(async (url: string) =>
      url.endsWith('/begin')
        ? new Response(JSON.stringify({ secret: 'ABCD', uri: 'otpauth://totp/x' }), { status: 200 })
        : new Response(JSON.stringify({ error: 'That code didn’t match.' }), { status: 400 }));
    renderPage();
    await screen.findByTestId('qr');
    const input = screen.getByLabelText('6-digit code') as HTMLInputElement;

    fireEvent.change(input, { target: { value: '000000' } });

    await screen.findByText('That code didn’t match.');
    expect(input.value).toBe('');
  });
});
