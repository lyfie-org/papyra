import { useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { CircleAlert, X } from 'lucide-react';
import { useDialogFocus } from '../hooks/useDialogFocus';
import { useUpdateStatus, type UpdateStatus } from '../hooks/useUpdateStatus';
import { versionLabel } from '../lib/serverVersion';
import { useT } from '../i18n/store';
import T from '../i18n/T';
import './UpdateNotice.css';

/**
 * Beside the version in the sidebar, for admins only (they are the ones who can pull a newer image):
 * a small "action required" icon when a newer Papyra is out, and the plain note it opens.
 * Renders nothing when there is nothing to do.
 */
export default function UpdateNotice() {
  const { status } = useUpdateStatus();
  const t = useT();
  const [open, setOpen] = useState(false);
  if (!status?.available || !status.latest) return null;
  return (
    <>
      <button
        type="button"
        className="update-notice"
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        aria-label={t('update.badge.label', { version: versionLabel(status.latest) })}
        title={t('update.badge.tip', { version: versionLabel(status.latest) })}
      >
        <CircleAlert size={16} aria-hidden="true" className="update-notice__icon" />
        <span className="update-notice__version workspace__nav-label">{versionLabel(status.latest)}</span>
        <span className="update-notice__tag workspace__nav-label">{t('update.badge.tag')}</span>
      </button>
      {open && <UpdateDialog status={status} onClose={() => setOpen(false)} />}
    </>
  );
}

function UpdateDialog({ status, onClose }: { status: UpdateStatus; onClose: () => void }) {
  const t = useT();
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
          <h2 id="update-title" className="update-dialog__title">{t('update.dialog.title')}</h2>
          <button type="button" className="update-dialog__close" aria-label={t('update.dialog.close')} onClick={onClose}><X size={18} /></button>
        </header>

        <p className="update-dialog__lede">
          <T k="update.dialog.lede" components={{ link: <a href={status.url ?? undefined} target="_blank" rel="noreferrer" /> }} />
        </p>

        <p className="update-dialog__versions">
          {t('update.dialog.serverVersion', { version: versionLabel(status.current) })}
          <br />
          {t('update.dialog.latestVersion', { version: status.latest ? versionLabel(status.latest) : '' })}
        </p>

        <p className="update-dialog__fine">{t('update.dialog.fine')}</p>

        <button type="button" className="update-dialog__ack" autoFocus onClick={onClose}>{t('update.dialog.acknowledge')}</button>
      </div>
    </div>,
    document.body,
  );
}
