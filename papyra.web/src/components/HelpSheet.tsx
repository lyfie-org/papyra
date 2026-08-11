import { useEffect, useRef } from 'react';
import { X } from 'lucide-react';
import { useDialogFocus } from '../hooks/useDialogFocus';
import './HelpSheet.css';

const SHORTCUTS: Array<[string, string]> = [
  ['⌘K / Ctrl+K', 'Search every note'],
  ['Esc', 'Close the note, a panel, or focus mode'],
  ['Enter', 'Add the category / to-do item you just typed'],
  ['Drag a .md onto the grid', 'Import it as a note'],
];

const CONCEPTS: Array<[string, string]> = [
  [
    'Your notes are files',
    'Every note is a Markdown file with YAML frontmatter on the server’s disk. Papyra reads and writes those files — nothing is trapped in a database, and anything that edits the folder (Syncthing, Obsidian, a text editor) works alongside it.',
  ],
  [
    'There is no save button',
    'Edits are written 1.5 seconds after you stop typing. The indicator above the note tells you where it stands: “Saving…”, “Saved to local disk”, or “Saved on this device — will sync”.',
  ],
  [
    'It keeps working offline',
    'With the server unreachable, Papyra still opens, still shows your notes, and still takes edits — they queue on this device and upload by themselves once the server is back. The dot at the bottom of the sidebar tells you how many are waiting.',
  ],
  [
    'Link notes with [[double brackets]]',
    'Type [[ in the editor to link another note. Every note shows its “Linked mentions” underneath, so you can walk backwards through your own references.',
  ],
  [
    'Nothing is really deleted',
    'Trash holds deleted notes for the retention window in Settings, and every note keeps timestamped snapshots — “File recovery” and “Time machine” in the note toolbar bring old text back.',
  ],
];

/**
 * The answer to "what is this and how do I use it". Papyra has a lot of quiet
 * machinery (files on disk, autosave, offline queue, snapshots) that a new user
 * has no way to discover; this is where it's stated plainly.
 */
export default function HelpSheet({ onClose }: { onClose: () => void }) {
  const sheetRef = useRef<HTMLElement | null>(null);
  useDialogFocus(sheetRef);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="help" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <section ref={sheetRef} className="help__sheet" role="dialog" aria-modal="true" aria-labelledby="help-title">
        <header className="help__head">
          <h2 className="help__title" id="help-title">How Papyra works</h2>
          <button type="button" className="help__close" aria-label="Close help" onClick={onClose}>
            <X size={18} />
          </button>
        </header>

        <div className="help__body">
          <ul className="help__concepts">
            {CONCEPTS.map(([title, text]) => (
              <li key={title} className="help__concept">
                <h3 className="help__concept-title">{title}</h3>
                <p className="help__concept-text">{text}</p>
              </li>
            ))}
          </ul>

          <h3 className="help__section">Shortcuts</h3>
          <dl className="help__keys">
            {SHORTCUTS.map(([key, what]) => (
              <div className="help__key-row" key={key}>
                <dt><kbd className="help__kbd">{key}</kbd></dt>
                <dd>{what}</dd>
              </div>
            ))}
          </dl>
        </div>
      </section>
    </div>
  );
}
