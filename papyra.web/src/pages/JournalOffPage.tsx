import { BookOpen } from 'lucide-react';
import BusyButton from '../components/BusyButton';
import { useSaveJournalPrefs } from '../hooks/useJournal';
import { useToast } from '../lib/toastContext';
import '../components/EmptyState.css';

/**
 * What any journal address shows while the journal is switched off: a stale link, a
 * bookmarked day, a `[[2026-09-14]]` link in a note. It says so quietly and offers the
 * way back. It never says "deleted" — nothing is.
 */
export default function JournalOffPage() {
  const save = useSaveJournalPrefs();
  const { toast } = useToast();

  async function turnOn() {
    try {
      await save.mutateAsync({ enabled: true });
    } catch {
      toast('Couldn’t turn the journal on. Try again in a moment.');
    }
  }

  return (
    <section className="empty-state">
      <BookOpen className="empty-state__icon" size={22} aria-hidden={true} />
      <h1 className="empty-state__title">The journal is off</h1>
      <p className="empty-state__body">Your days are safe in your folder. Turn the journal on to see them again.</p>
      <BusyButton type="button" className="empty-state__action" busyLabel="Turning on…" onClick={turnOn}>
        Turn it on
      </BusyButton>
    </section>
  );
}
