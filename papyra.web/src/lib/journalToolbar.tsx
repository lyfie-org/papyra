import { Mic } from 'lucide-react';
import type { ExtensiveToolbarItem } from '@lyfie/luthor/presets/extensive';
import { createToolbarItems } from './editorToolbar';

/**
 * The journal's toolbar: Papyra's own items minus `@` — the journal is private,
 * so there is no one to mention — plus a voice note under Insert, where the
 * browser can record. (Other journal-only inserts live in the slash menu; see journalSlash.)
 */
export function createJournalToolbarItems(
  { recordVoice }: { recordVoice?: (upload: (file: File) => Promise<void>) => void } = {},
): ExtensiveToolbarItem[] {
  const items = createToolbarItems({ mention: false });
  if (!recordVoice) return items;
  return items.map((item) => item.id !== 'papyra.insert' || !('items' in item) || !item.items ? item : {
    ...item,
    items: [
      ...item.items,
      {
        id: 'journal.voice',
        label: 'Voice note',
        icon: <Mic size={16} strokeWidth={2} aria-hidden="true" />,
        action: ({ runCommand, hasCommand }) => {
          if (!hasCommand('uploadAndEmbedFile')) return;
          recordVoice(async (file) => { await runCommand('uploadAndEmbedFile', file); });
        },
      },
    ],
  });
}
