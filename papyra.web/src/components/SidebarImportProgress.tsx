import { useEffect, useRef, type CSSProperties } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { Upload } from 'lucide-react';
import { useImportStatus, importSummary } from '../hooks/useImportStatus';
import { useToast } from '../lib/toastContext';
import './SidebarImportProgress.css';

// A running import, visible from anywhere: a slim bar in the sidebar that links
// back to Settings → Import. When the job finishes while the person is elsewhere,
// the outcome arrives as a toast so it's never missed.
export default function SidebarImportProgress() {
  const { data: status } = useImportStatus();
  const { toast } = useToast();
  const seenRunning = useRef<string | null>(null);
  // Settings → Import already shows the outcome in place; don't say it twice.
  const onSettings = useLocation().pathname.startsWith('/settings');

  const running = !!status && !status.done;

  useEffect(() => {
    if (!status) return;
    if (!status.done) { seenRunning.current = status.jobId; return; }
    // Only announce a job this tab watched run — not a summary left from before.
    if (seenRunning.current === status.jobId) {
      seenRunning.current = null;
      if (!onSettings) toast(importSummary(status));
    }
  }, [status, toast, onSettings]);

  if (!running) return null;

  const pct = status.total > 0 ? Math.round((status.processed / status.total) * 100) : 0;
  const label = status.total > 0 ? `Importing ${status.processed}/${status.total}` : 'Import queued';

  return (
    <Link
      to="/settings?tab=data&s=import"
      className="sidebar-import"
      title={`${label} — open Import settings`}
    >
      <span className="sidebar-import__row">
        <Upload className="workspace__nav-icon sidebar-import__icon" size={14} aria-hidden="true" />
        <span className="sidebar-import__label workspace__nav-label">{label}</span>
      </span>
      <span
        className="sidebar-import__bar"
        role="progressbar"
        aria-label="Import progress"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
        style={{ '--frac': pct / 100 } as CSSProperties}
      />
    </Link>
  );
}
