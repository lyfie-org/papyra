import type { ExtensiveSlashCommand } from '@lyfie/luthor/presets/extensive';
import { longDate } from './journalDay';
import { MOODS } from './journalMood';
import { pickFile } from './pickFile';
import type { Mood } from '../types/journal';

export interface JournalSlashDeps {
  /** The day on the page (`yyyy-MM-dd`). */
  day: string;
  /** Set (or clear, with null) how the day felt. */
  setMood: (mood: Mood | null) => void;
  /** Ask which to-do to show here, live. */
  pickTodo: () => void;
  /** Start a voice note; `upload` puts the finished file in the page. Omitted where the browser can't record. */
  recordVoice?: (upload: (file: File) => Promise<void>) => void;
}

/**
 * What `/` offers on a journal page, after Papyra's own three (Link note, Embed
 * media, Insert date): the things a day is made of. Each writes through the slash
 * context the way the built-ins do, so the day stays plain markdown.
 */
export function createJournalSlashCommands({ day, setMood, pickTodo, recordVoice }: JournalSlashDeps): ExtensiveSlashCommand[] {
  const voice: ExtensiveSlashCommand[] = recordVoice ? [{
    id: 'journal.voice',
    label: 'Voice note',
    description: 'Record a few words, right here',
    category: 'Journal',
    keywords: ['voice', 'record', 'audio', 'microphone', 'speak', 'dictate'],
    action: ({ runCommand, hasCommand }) => {
      if (!runCommand || !hasCommand?.('uploadAndEmbedFile')) return;
      recordVoice(async (file) => { await runCommand('uploadAndEmbedFile', file); });
    },
  }] : [];
  return [
    {
      id: 'journal.date',
      label: 'This day’s date',
      description: 'Write out the date of this page',
      category: 'Journal',
      keywords: ['date', 'today', 'day', 'heading'],
      action: ({ insertText }) => { insertText(longDate(day)); },
    },
    {
      id: 'journal.link-day',
      label: 'Link a day',
      description: 'Link another day: yesterday, last fri, sep 14',
      category: 'Journal',
      keywords: ['day', 'link', 'yesterday', 'date', 'calendar'],
      // The `[[` opens the same menu a note link does; it understands "yesterday" and "sep 14".
      action: ({ insertText }) => { insertText('[['); },
    },
    {
      id: 'journal.link-todo',
      label: 'Link a to-do',
      description: 'Link a to-do list by name',
      category: 'Journal',
      keywords: ['todo', 'to-do', 'task', 'list', 'link'],
      action: ({ insertText }) => { insertText('[['); },
    },
    {
      id: 'journal.embed-todo',
      label: 'Embed a to-do',
      description: 'Show a to-do list here, with boxes you can tick',
      category: 'Journal',
      keywords: ['todo', 'to-do', 'checklist', 'embed', 'tasks', 'tick'],
      action: () => { pickTodo(); },
    },
    {
      id: 'journal.photo',
      label: 'Photo',
      description: 'Add a picture to this day',
      category: 'Journal',
      keywords: ['photo', 'picture', 'image', 'camera', 'upload'],
      action: async ({ runCommand, hasCommand }) => {
        const file = await pickFile('image/*');
        if (!file || !runCommand || !hasCommand?.('uploadAndEmbedFile')) return;
        // Progress, the placeholder and any failure are the upload pipeline's own (a toast).
        await Promise.resolve(runCommand('uploadAndEmbedFile', file)).catch(() => {});
      },
    },
    ...voice,
    ...MOODS.map(({ value, label }): ExtensiveSlashCommand => ({
      id: `journal.mood-${value}`,
      label: `Mood: ${label}`,
      description: 'How the day felt',
      category: 'Journal',
      keywords: ['mood', 'feel', 'feeling', label.toLowerCase(), 'weather'],
      action: () => { setMood(value); },
    })),
  ];
}
