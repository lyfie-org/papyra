// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { FocusContext, type FocusApi } from '../hooks/useFocus';
import { JournalDayPage } from './JournalPage';

// The page's own job is the bar and what sits beside the sheet; the sheet and the panel are tested on their own.
vi.mock('../components/journal/EntrySheet', () => ({ default: () => <article aria-label="sheet" /> }));
vi.mock('../components/journal/JournalAside', () => ({ default: () => <aside id="journal-aside" aria-label="panel" /> }));

const focusApi = (over: Partial<FocusApi> = {}): FocusApi => ({
  focus: false, pending: 0, enter: vi.fn(), exit: vi.fn(), flush: vi.fn(), onExternalUpdate: vi.fn(), ...over,
});

function mount(focus: FocusApi) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(['journal', 'today'], {
    date: '2026-10-27', entry: {}, stats: { current: 3, todayWritten: false }, settings: { hideStreak: false }, pinSet: true,
  });
  return render(
    <QueryClientProvider client={client}>
      <FocusContext.Provider value={focus}>
        <MemoryRouter initialEntries={['/journal/2026-10-21']}>
          <Routes><Route path="/journal/:date" element={<JournalDayPage />} /></Routes>
        </MemoryRouter>
      </FocusContext.Provider>
    </QueryClientProvider>,
  );
}

beforeEach(() => { vi.stubGlobal('fetch', vi.fn(async () => new Response('{}'))); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('the journal page bar', () => {
  it('opens the calendar from the date, and has no calendar button or date input of its own', () => {
    const { container } = mount(focusApi());
    const date = screen.getByRole('link', { name: /21 Oct 2026|Oct 21, 2026|October 21, 2026/ });
    expect(date.getAttribute('href')).toBe('/journal/calendar?m=2026-10');
    expect(screen.queryByRole('link', { name: 'Calendar' })).toBeNull();
    expect(container.querySelector('input[type="date"]')).toBeNull();
  });

  it('keeps notes and to-dos out of the way until the button asks for them', () => {
    mount(focusApi());
    expect(screen.queryByRole('complementary', { name: 'panel' })).toBeNull();
    const button = screen.getByRole('button', { name: /Notes & to-dos/ });
    expect(button.getAttribute('aria-pressed')).toBe('false');

    fireEvent.click(button);
    expect(screen.getByRole('complementary', { name: 'panel' })).toBeTruthy();
    expect(button.getAttribute('aria-pressed')).toBe('true');

    fireEvent.click(button);
    expect(screen.queryByRole('complementary', { name: 'panel' })).toBeNull();
  });

  it('leaves focus mode when the page is left, so it never follows you to the notes', () => {
    const focus = focusApi({ focus: true });
    const { unmount } = mount(focus);
    expect(focus.exit).not.toHaveBeenCalled();
    unmount();
    expect(focus.exit).toHaveBeenCalled();
  });
});
