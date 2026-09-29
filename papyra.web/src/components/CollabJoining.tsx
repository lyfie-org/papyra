import { Loader2 } from 'lucide-react';
import MarkdownPreview from './MarkdownPreview';
import './CollabJoining.css';

/**
 * What a live note shows until its room has sent the document: the text we
 * already have, blurred and inert, under a "Joining" chip. An empty canvas read
 * as a note that had lost its contents; this reads as a note on its way. Not
 * editable — typing into a doc the room hasn't filled would land beside the
 * note — so the live editor stays hidden underneath until it has synced.
 */
export default function CollabJoining({ body }: { body: string }) {
  return (
    <div className="collab-joining">
      {body.trim() && (
        <div className="collab-joining__ghost" aria-hidden="true">
          <MarkdownPreview body={body} />
        </div>
      )}
      <div className="collab-joining__chip" role="status">
        <Loader2 size={14} className="collab-joining__spin" aria-hidden="true" />
        Joining the live note…
      </div>
    </div>
  );
}
