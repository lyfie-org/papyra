import { useEffect, useRef } from 'react';
import { X } from 'lucide-react';
import { useDialogFocus } from '../hooks/useDialogFocus';
import './HelpSheet.css';

const SHORTCUTS: Array<[string, string]> = [
  ['⌘K / Ctrl+K', 'Search every note'],
  ['/', 'In a note: add a heading, list, table, picture, map or any link'],
  ['Shift+Enter', 'On a search result: show it where it lives, instead of opening it'],
  ['↑ / ↓ on the outline', 'Pick a heading in a long note’s outline rail; Enter jumps to it'],
  ['Esc', 'Leave the note body (Tab indents there); again to close the note, a panel, or focus mode'],
  ['Enter', 'Add the tag / to-do item you just typed'],
  ['⌘⇧L / Ctrl+Shift+L', 'Lock your vault (while it’s open)'],
  ['Drag a text file onto the grid', 'Import it as a note'],
];

const CONCEPTS: Array<[string, string]> = [
  [
    'Your notes are ordinary files',
    'Each note is a plain text file in a folder on your server — the same kind of file any text editor can open. Nothing is locked inside Papyra, so you can copy the folder, back it up, or open it with another app, and Papyra will pick up whatever changed.',
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
    'Type / for anything',
    'A slash at the start of a line opens a menu of everything a note can hold — headings, lists, checklists, tables, pictures, and embeds. Keep typing to narrow it (“/table”, “/embed”). Embed takes any link you have: a Google or Apple Maps place, a video, a song, a document, a web page.',
  ],
  [
    'Drag pictures and embeds where you want them',
    'Press on a picture, a file, a link card or an embed and drag it up or down the note; Esc cancels. Videos and maps move by the grip beside their corner. Rest the pointer on an embed to preview its page; click the preview to open it.',
  ],
  [
    'Notes shared with you work like your own',
    'Pin them, give them your own tags, copy them, download them or copy their link from the card. With edit access you can also change a note’s colour (everyone sees it) and share it with someone else — it stays its owner’s note. Its [[links]] open the notes they point to when those are shared with you too. Sharing a note that links to others? The share dialog can send those along.',
  ],
  [
    'Link notes with [[double brackets]]',
    'Type [[ in the editor to link another note. Every note shows its “Linked mentions” underneath, so you can walk backwards through your own references.',
  ],
  [
    'Name someone with @ and they hear about it',
    'Typing @ and their username in a note notifies them (the inbox button in the top bar), and Papyra asks whether to share the note with them — as an editor or view-only. Access is always the whole note or nothing: if you don’t share, they see who mentioned them and can ask you for access. Anyone with view-only access can ask for edit access, and you approve or decline from the same notifications tray. A locked note is never shared and never delivers a mention.',
  ],
  [
    'Deleting gives you time to change your mind',
    'A deleted note goes to Trash and stays there for the period you choose in Settings — 30 days by default. Until then you can put it back. Once that period is up the note is erased for good, and no one can recover it. To keep something forever, restore it from Trash before the time runs out.',
  ],
  [
    'Older versions are kept too',
    'Every note quietly saves earlier versions as you work. “File recovery” and “Time machine” in the note toolbar bring back text you overwrote — separate from Trash, and useful when the note still exists but you want yesterday’s wording.',
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
