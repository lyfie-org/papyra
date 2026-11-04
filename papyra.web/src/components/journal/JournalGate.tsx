import { Outlet } from 'react-router-dom';
import { useJournalEnabled } from '../../hooks/useJournal';
import JournalOffPage from '../../pages/JournalOffPage';

/** Wraps every journal route: the journal's pages while it is on, a quiet "it's off" page while it isn't. */
export default function JournalGate() {
  return useJournalEnabled() ? <Outlet /> : <JournalOffPage />;
}
