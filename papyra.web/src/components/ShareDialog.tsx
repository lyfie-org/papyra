import { useEffect, useState } from 'react';
import { Link2, Users, X } from 'lucide-react';
import type { Note } from '../types/note';
import './ShareDialog.css';

// Placeholder share surface (Microsoft-style): a people list with access levels
// and a shareable link. The real sharing/permissions backend lands later — this
// dialog only renders the shape so the Share + Copy-link entry points are wired.
export default function ShareDialog({ note, onClose }: { note: Note; onClose: () => void }) {
  const url = `${window.location.origin}/note/${encodeURIComponent(note.id)}`;
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* clipboard blocked — leave the field for manual copy */ }
  }

  return (
    <div className="share" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="share__dialog" role="dialog" aria-modal="true" aria-label="Share note">
        <header className="share__head">
          <h2 className="share__title">Share “{note.title.trim() || 'Untitled'}”</h2>
          <button type="button" className="share__close" aria-label="Close" onClick={onClose}>
            <X size={18} />
          </button>
        </header>

        <p className="share__note">Sharing is a placeholder for now — wiring lands later.</p>

        <label className="share__field">
          Invite people
          <div className="share__invite">
            <Users size={16} />
            <input placeholder="Add people by name or email" disabled />
          </div>
        </label>

        <ul className="share__people">
          <li className="share__person">
            <span className="share__avatar" aria-hidden="true">O</span>
            <span className="share__person-name">You (owner)</span>
            <span className="share__access">Owner</span>
          </li>
        </ul>

        <label className="share__field">
          Anyone with the link
          <select className="share__access-select" defaultValue="view" disabled>
            <option value="view">Can view</option>
            <option value="edit">Can edit</option>
          </select>
        </label>

        <div className="share__link">
          <Link2 size={16} />
          <input readOnly value={url} onFocus={(e) => e.currentTarget.select()} />
          <button type="button" className="share__copy" onClick={() => void copy()}>
            {copied ? 'Copied' : 'Copy link'}
          </button>
        </div>
      </div>
    </div>
  );
}
