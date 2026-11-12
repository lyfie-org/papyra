import { useEffect, useState } from 'react';
import { Loader2, TriangleAlert } from 'lucide-react';
import { waitForRestart } from '../hooks/useInstanceBackup';
import './RestartWatch.css';

/**
 * Shown after a restore has been handed to the server: Papyra stops, starts on
 * the restored accounts and settings, and this reloads the page once it answers.
 */
export default function RestartWatch() {
  const [stopped, setStopped] = useState(false);

  useEffect(() => {
    const abort = new AbortController();
    void waitForRestart(abort.signal).then(result => {
      if (abort.signal.aborted) return;
      if (result === 'back') window.location.assign('/');
      else setStopped(true);
    });
    return () => abort.abort();
  }, []);

  return stopped ? (
    <p className="restart-watch" role="alert">
      <TriangleAlert size={15} aria-hidden="true" />
      <span>
        Papyra stopped and didn’t start again by itself. Start it, then reload this page. The restored accounts and
        settings are already in place.
      </span>
    </p>
  ) : (
    <p className="restart-watch" role="status">
      <Loader2 size={15} className="restart-watch__spin" aria-hidden="true" />
      <span>The backup is in. Papyra is restarting on it, and this page will reload when it’s back.</span>
    </p>
  );
}
