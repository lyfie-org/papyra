import { ShieldCheck } from 'lucide-react';
import NoteGrid from '../components/NoteGrid';
import { useNotes } from '../hooks/useNotes';
import './NotesPage.css';

/**
 * The locked vault: every note marked `secure: true`.
 *
 * These notes were always supported — the server withholds the body until a
 * WebAuthn unlock, and the editor renders a lock instead of the text — but they
 * had no home of their own. They do still appear on the notes desk (the desk
 * filters on archived/trashed/kind, not on `secure`), so this page is a focused
 * view rather than a rescue: somewhere to see everything currently protected,
 * and somewhere the feature is discoverable from the sidebar at all.
 *
 * The bodies are withheld server-side, so the cards show a locked placeholder
 * rather than a snippet; opening one runs the normal unlock gate.
 */
export default function VaultPage() {
  const { data: notes, isLoading, isError } = useNotes();
  const secure = (notes ?? []).filter((n) => n.secure && !n.trashed);

  return (
    <section className="notes-page">
      <header className="notes-page__bar">
        <h1 className="page-title notes-page__title">Vault</h1>
      </header>

      <p className="notes-page__lede">
        Notes marked <code>secure: true</code>. Their contents stay on the server until you
        unlock them with a registered device — Papyra never sends the body to this page.
      </p>

      {isLoading && <p className="notes-page__status">Loading…</p>}
      {isError && <p className="notes-page__status">Couldn’t reach the server.</p>}
      {!isLoading && !isError && secure.length === 0 && (
        <p className="notes-page__status">
          <ShieldCheck size={16} aria-hidden="true" /> No locked notes yet. Add{' '}
          <code>secure: true</code> to a note’s frontmatter to keep it here.
        </p>
      )}
      {!isLoading && !isError && secure.length > 0 && (
        <NoteGrid notes={secure} variant="active" emptyLabel="No locked notes." />
      )}
    </section>
  );
}
