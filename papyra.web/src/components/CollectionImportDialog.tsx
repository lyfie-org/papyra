import { useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { useImportCollection } from '../hooks/useCollections';
import { useDialogFocus } from '../hooks/useDialogFocus';
import { useToast } from '../lib/toastContext';
import BusyButton from './BusyButton';
import './ShareDialog.css';
import './CollectionShareDialog.css';

/** Paste a collection someone copied as JSON; a copy of it joins yours. */
export default function CollectionImportDialog({ onClose }: { onClose: () => void }) {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  useDialogFocus(dialogRef);
  const add = useImportCollection();
  const { toast } = useToast();
  const [text, setText] = useState('');

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!text.trim() || add.isPending) return;
    try {
      const created = await add.mutateAsync(text);
      toast(`Added “${created.name}” to your collections.`);
      onClose();
    } catch { /* shown from add.error */ }
  }

  return createPortal(
    <div
      className="share"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
      onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } }}
    >
      <form ref={dialogRef as React.RefObject<HTMLFormElement | null>} className="share__dialog collection-share"
        role="dialog" aria-modal="true" aria-label="Import a collection" onSubmit={submit}>
        <header className="share__head">
          <h2 className="share__title">Import a collection</h2>
          <button type="button" className="share__close" aria-label="Close" onClick={onClose}><X size={18} /></button>
        </header>
        <p className="collection-share__lede">Paste a collection copied from Share → Copy as JSON.</p>
        {add.error && <p className="share__error" role="alert">{add.error.message}</p>}
        <textarea
          className="collection-share__json"
          aria-label="Collection JSON"
          autoFocus
          spellCheck={false}
          rows={8}
          placeholder={'{ "papyraCollection": 1, "name": "…", "rules": { … } }'}
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <div className="collection-share__row collection-share__row--end">
          <BusyButton type="submit" className="share__btn" disabled={!text.trim()} busy={add.isPending} busyLabel="Adding…">
            Add collection
          </BusyButton>
        </div>
      </form>
    </div>,
    document.body,
  );
}
