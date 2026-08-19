// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, within, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { Note } from '../types/note';

// The search box is the one surface every source has to agree on, so the test
// drives the real component and stubs only its data — the hooks and the index
// endpoint. What is asserted is what a person sees: which rows appear, under
// which heading, carrying which trail, and where Enter takes them.

const navigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, useNavigate: () => navigate };
});

const notes: Note[] = [
  {
    id: 'n1', title: 'Roast recipes', tags: [], color: null, pinned: false, archived: false,
    kind: 'note', trashed: false, updated: '2026-01-01T00:00:00Z', body: 'Slow roast recipes for winter.',
  },
  {
    id: 't1', title: 'Shopping list', tags: [], color: null, pinned: false, archived: false,
    kind: 'todo', trashed: false, updated: '2026-01-01T00:00:00Z', body: '- [ ] recipes ingredients',
  },
];

let role = 'Admin';
vi.mock('../hooks/useNotes', () => ({ useNotes: () => ({ data: notes }) }));
vi.mock('../hooks/useAuth', () => ({ useAuth: () => ({ state: 'authed', user: { id: 1, username: 'a', name: 'A', email: '', role } }) }));
vi.mock('../hooks/useCategories', () => ({
  useCategories: () => ({ data: [{ name: 'Recipes', color: null, count: 4 }] }),
}));
vi.mock('../hooks/useCollections', () => ({
  useCollections: () => ({ data: [{ id: 7, name: 'Recipes to try', rulesJson: '{}', createdUtc: '' }] }),
}));
// Offline keeps the network out of it: the local fallback produces the note
// hits, which is the same shape the endpoint returns.
vi.mock('../hooks/useSync', () => ({ useSyncState: () => ({ online: false, syncing: false, pending: 0 }) }));

const { default: SearchBar } = await import('./SearchBar');

function type(value: string) {
  render(<MemoryRouter><SearchBar /></MemoryRouter>);
  const input = screen.getByRole('combobox');
  fireEvent.change(input, { target: { value } });
  return input;
}

beforeEach(() => { role = 'Admin'; navigate.mockClear(); });
afterEach(cleanup);

describe('SearchBar', () => {
  it('groups results by what they are, in a fixed order', () => {
    type('recipes');
    // By class, not by text: "To Do" is also a breadcrumb inside its own rows.
    const headings = [...document.querySelectorAll('.search__group')].map(el => el.textContent);
    expect(headings).toEqual(['Notes', 'To Do', 'Categories', 'Collections']);
  });

  it('labels each hit with the trail to where it lives', () => {
    type('recipes');
    const options = screen.getAllByRole('option');
    const titled = (name: string) => options.find(o => within(o).queryByText(name));

    expect(within(titled('Roast recipes')!).getByText('Note')).toBeTruthy();
    expect(within(titled('Shopping list')!).getByText('To Do')).toBeTruthy();
    expect(within(titled('Recipes')!).getByText('Category')).toBeTruthy();
    expect(within(titled('Recipes to try')!).getByText('Collection')).toBeTruthy();
  });

  it('finds a settings page and breadcrumbs it under its tab', () => {
    type('smtp');
    const option = screen.getAllByRole('option')[0];
    expect(within(option).getByText('Outbound email (SMTP)')).toBeTruthy();
    expect(within(option).getByText('Settings › Email')).toBeTruthy();
  });

  it('never shows an admin-only page to someone who is not an admin', () => {
    role = 'User';
    type('smtp');
    expect(screen.queryByText('Outbound email (SMTP)')).toBeNull();
    expect(screen.getByText('No matches.')).toBeTruthy();
  });

  it('opens a settings hit at its section, not the top of the tab', () => {
    type('smtp');
    fireEvent.click(screen.getAllByRole('option')[0]);
    expect(navigate).toHaveBeenCalledWith('/settings?tab=email&s=smtp');
  });

  it('walks the whole flat list with the arrow keys, headings included', () => {
    const input = type('recipes');
    const selected = () => screen.getAllByRole('option').findIndex(o => o.getAttribute('aria-selected') === 'true');

    expect(selected()).toBe(0);
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(selected()).toBe(1);
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    // Wraps to the last result — which is a collection, three groups down.
    expect(selected()).toBe(screen.getAllByRole('option').length - 1);
  });

  it('opens whatever the keyboard is on', () => {
    const input = type('recipes');
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(navigate).toHaveBeenCalledWith('/note/t1');
  });

  it('keeps the highlight on a real row as the list shrinks', () => {
    const input = type('recipes');
    fireEvent.keyDown(input, { key: 'ArrowUp' }); // last row
    // Narrowing to one result must not leave the highlight past the end.
    fireEvent.change(input, { target: { value: 'shopping' } });
    const options = screen.getAllByRole('option');
    expect(options).toHaveLength(1);
    expect(options[0].getAttribute('aria-selected')).toBe('true');
  });

  it('says the results came from this device only when notes are among them', () => {
    type('recipes');
    expect(screen.getByText(/Searching this device/)).toBeTruthy();

    cleanup();
    // "smtp" matches a settings page and nothing in the vault, so the offline
    // notice would be describing results that never came from the index.
    type('smtp');
    expect(screen.queryByText(/Searching this device/)).toBeNull();
  });
});
