import { FilePlus2, FolderInput, Sparkles, WifiOff } from 'lucide-react';
import { Link } from 'react-router-dom';
import './FirstRun.css';

/**
 * What a brand-new vault shows instead of "No notes yet." A first-run screen has
 * one job: say what this thing is, and give the user the very next action. The
 * three cards are the three real ways notes get in here.
 */
export default function FirstRun({ onCreate }: { onCreate: () => void }) {
  return (
    <section className="firstrun" aria-labelledby="firstrun-title">
      <h2 className="firstrun__title" id="firstrun-title">Your vault is empty</h2>
      <p className="firstrun__lede">
        Papyra keeps every note as a Markdown file on your own server — plain text you
        can read, back up, and edit with anything else. Start it however you like.
      </p>

      <ul className="firstrun__cards">
        <li className="firstrun__card">
          <FilePlus2 className="firstrun__icon" size={20} aria-hidden="true" />
          <h3 className="firstrun__card-title">Write one</h3>
          <p className="firstrun__card-text">
            A blank note, saved as you type. No save button — the indicator above the
            note tells you when it has hit the disk.
          </p>
          <button type="button" className="firstrun__action" onClick={onCreate}>
            New note
          </button>
        </li>

        <li className="firstrun__card">
          <FolderInput className="firstrun__icon" size={20} aria-hidden="true" />
          <h3 className="firstrun__card-title">Bring notes with you</h3>
          <p className="firstrun__card-text">
            Drag <code>.md</code> or <code>.txt</code> files straight onto this page, or
            import a whole Obsidian or Google&nbsp;Keep export.
          </p>
          <Link className="firstrun__action firstrun__action--quiet" to="/settings?tab=data">
            Open import
          </Link>
        </li>

        <li className="firstrun__card">
          <Sparkles className="firstrun__icon" size={20} aria-hidden="true" />
          <h3 className="firstrun__card-title">Then ask it things</h3>
          <p className="firstrun__card-text">
            Search with <kbd>⌘K</kbd>, link notes with <code>[[double brackets]]</code>,
            and use the spark icon to ask questions across everything you&rsquo;ve written.
          </p>
        </li>
      </ul>

      <p className="firstrun__footnote">
        <WifiOff size={14} aria-hidden="true" />
        Works offline too — edits made without a connection are kept on this device and
        upload themselves when the server is back.
      </p>
    </section>
  );
}
