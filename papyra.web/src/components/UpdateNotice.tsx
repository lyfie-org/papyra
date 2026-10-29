import { useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { CircleAlert, X } from 'lucide-react';
import { useDialogFocus } from '../hooks/useDialogFocus';
import { useUpdateStatus, type UpdateStatus } from '../hooks/useUpdateStatus';
import { versionLabel } from '../lib/serverVersion';
import './UpdateNotice.css';

/**
 * Beside the version in the sidebar, for admins only (they are the ones who can pull a newer image):
 * a small "action required" icon when a newer Papyra is out, and the plain note it opens.
 * Renders nothing when there is nothing to do.
 */
export default function UpdateNotice() {
  const { status } = useUpdateStatus();
  const [open, setOpen] = useState(false);
  if (!status?.available || !status.latest) return null;
  return (
    <>
      <button
        type="button"
        className="update-notice"
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        aria-label={`Update available: Papyra ${versionLabel(status.latest)}. Show details.`}
        title={`Papyra ${versionLabel(status.latest)} is available`}
      >
        <CircleAlert size={16} aria-hidden="true" className="update-notice__icon" />
        <span className="update-notice__version workspace__nav-label">{versionLabel(status.latest)}</span>
        <span className="update-notice__tag workspace__nav-label">New update!</span>
      </button>
      {open && <UpdateDialog status={status} onClose={() => setOpen(false)} />}
    </>
  );
}

function UpdateDialog({ status, onClose }: { status: UpdateStatus; onClose: () => void }) {
  const ref = useRef<HTMLDivElement | null>(null);
  useDialogFocus(ref);

  return createPortal(
    <div
      className="update-dialog"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
      onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }}
    >
      <div ref={ref} className="update-dialog__card" role="dialog" aria-modal="true" aria-labelledby="update-title">
        <header className="update-dialog__head">
          <h2 id="update-title" className="update-dialog__title">New version available</h2>
          <button type="button" className="update-dialog__close" aria-label="Close" onClick={onClose}><X size={18} /></button>
        </header>

        <p className="update-dialog__lede">
          A new version of Papyra is available. Please take a moment to read the{' '}
          <a href={status.url ?? undefined} target="_blank" rel="noreferrer">release notes</a> before
          you update, especially if something updates your container for you.
        </p>

        <p className="update-dialog__versions">
          Server version: {versionLabel(status.current)}
          <br />
          Latest version: {status.latest ? versionLabel(status.latest) : ''}
        </p>

        <button type="button" className="update-dialog__ack" autoFocus onClick={onClose}>Acknowledge</button>
      </div>
    </div>,
    document.body,
  );
}
