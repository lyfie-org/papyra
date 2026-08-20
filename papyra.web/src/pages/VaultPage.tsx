import { Lock } from 'lucide-react';
import NoteGrid from '../components/NoteGrid';
import EmptyState from '../components/EmptyState';
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
        Locked notes. Their contents stay on the server until you unlock them with a
        registered device — nothing is sent to this page before then.
      </p>

      {isLoading && <p className="notes-page__status">Loading…</p>}
      {isError && <p className="notes-page__status">Couldn’t reach the server.</p>}
      {!isLoading && !isError && (
        <NoteGrid
          notes={secure}
          variant="active"
          empty={
            <EmptyState
              icon={Lock}
              title="No locked notes"
              body="Locking a note keeps its contents hidden until you unlock it. Locked notes stay out of search results and are never sent to the assistant, so nothing can quote them back at you."
              hint="To lock a note, open it and choose Lock in the toolbar above it."
            />
          }
        />
      )}
    </section>
  );
}
