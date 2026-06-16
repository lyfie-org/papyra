import NoteGrid from '../components/NoteGrid';
import type { Note } from '../types/note';

// Placeholder data until TanStack Query wiring lands in Sprint 4.3.
const SAMPLE_NOTES: Note[] = [
  { id: '1', title: 'Reading list', tags: ['books'], color: null, pinned: true,
    body: 'The Left Hand of Darkness, Piranesi, Annihilation. Pick the next one this weekend.' },
  { id: '2', title: 'Garden plan', tags: ['home', 'spring'], color: '#e8efe2', pinned: true,
    body: 'Tomatoes along the south fence. Basil in the planters. Order seeds before March.' },
  { id: '3', title: '', tags: [], color: null, pinned: false,
    body: 'Quick thought with no title — should fall back to Untitled gracefully.' },
  { id: '4', title: 'Standup notes', tags: ['work'], color: '#f3e8e2', pinned: false,
    body: 'Shipped the search endpoint. Next: masonry grid. Blocked on nothing.' },
  { id: '5', title: 'Recipes to try', tags: ['food'], color: null, pinned: false,
    body: 'Shakshuka, miso-glazed eggplant, a proper focaccia with rosemary and flaky salt on top.' },
  { id: '6', title: 'Trip ideas', tags: ['travel', 'someday'], color: '#e7ecf2', pinned: false,
    body: 'Lisbon in autumn. Kyoto for the maples. A long slow train through the Alps.' },
];

export default function NotesPage() {
  return (
    <section>
      <NoteGrid notes={SAMPLE_NOTES} />
    </section>
  );
}
