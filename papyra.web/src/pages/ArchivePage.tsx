import { Archive } from 'lucide-react';
import NoteGrid from '../components/NoteGrid';
import EmptyState from '../components/EmptyState';
import { useNotes } from '../hooks/useNotes';
import './NotesPage.css';
import LoadingBar from '../components/LoadingBar';
import JournalBin from '../components/journal/JournalBin';
import { useJournalBin } from '../hooks/useJournal';
import { useT } from '../i18n/store';

export default function ArchivePage() {
  const t = useT();
  const { data: notes, isLoading, isError } = useNotes();
  // Days of the journal set aside count: "Nothing archived" would be untrue above them.
  const journalDays = useJournalBin('archived').data?.length ?? 0;

  return (
    <section className="notes-page">
      <header className="notes-page__bar">
        <h1 className="page-title notes-page__title">Archive</h1>
      </header>

      {isLoading && <LoadingBar label="Loading archive" />}
      {isError && <p className="notes-page__status">{t('common.serverUnreachable')}</p>}
      {!isLoading && !isError && (
        <NoteGrid
          notes={notes ?? []}
          variant="archived"
          selectable
          empty={journalDays > 0 ? <></> : (
            <EmptyState
              icon={Archive}
              title="Nothing archived"
              body="Archiving clears a note off your Notes page without deleting it. Everything here is kept for good and stays searchable — this is the place for things you have finished with but don’t want to lose."
              hint="To archive something, open a note and choose Archive in the toolbar above it."
            />
          )}
        />
      )}

      <JournalBin state="archived" />
    </section>
  );
}
