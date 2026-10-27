import { describe, expect, it, vi } from 'vitest';
import { createJournalSlashCommands } from './journalSlash';
import { longDate } from './journalDay';

const deps = () => ({ day: '2026-10-25', setMood: vi.fn(), pickTodo: vi.fn() });
const find = (cmds: ReturnType<typeof createJournalSlashCommands>, id: string) => cmds.find((c) => c.id === id)!;

describe('journal slash commands', () => {
  it('offers the things a day is made of, under one heading', () => {
    const cmds = createJournalSlashCommands(deps());
    expect(cmds.map((c) => c.id)).toEqual([
      'journal.date', 'journal.link-day', 'journal.link-todo', 'journal.embed-todo', 'journal.photo',
      'journal.mood-1', 'journal.mood-2', 'journal.mood-3', 'journal.mood-4', 'journal.mood-5',
    ]);
    expect(new Set(cmds.map((c) => c.category))).toEqual(new Set(['Journal']));
    expect(new Set(cmds.map((c) => c.id)).size).toBe(cmds.length);
  });

  it('offers a voice note only where the browser can record, and hands it the page’s upload', async () => {
    expect(createJournalSlashCommands(deps()).some((c) => c.id === 'journal.voice')).toBe(false);

    const recordVoice = vi.fn();
    const cmds = createJournalSlashCommands({ ...deps(), recordVoice });
    expect(cmds.map((c) => c.id)).toContain('journal.voice');

    const runCommand = vi.fn().mockResolvedValue(undefined);
    await find(cmds, 'journal.voice').action({ insertText: vi.fn(), runCommand, hasCommand: () => true });
    expect(recordVoice).toHaveBeenCalledTimes(1);
    const file = new File(['x'], 'voice.weba');
    await recordVoice.mock.calls[0][0](file);
    expect(runCommand).toHaveBeenCalledWith('uploadAndEmbedFile', file);
  });

  it('writes the page’s own date', async () => {
    const insertText = vi.fn();
    await find(createJournalSlashCommands(deps()), 'journal.date').action({ insertText });
    expect(insertText).toHaveBeenCalledWith(longDate('2026-10-25'));
  });

  it('opens the link menu for a day and for a to-do', async () => {
    const insertText = vi.fn();
    const cmds = createJournalSlashCommands(deps());
    await find(cmds, 'journal.link-day').action({ insertText });
    await find(cmds, 'journal.link-todo').action({ insertText });
    expect(insertText).toHaveBeenNthCalledWith(1, '[[');
    expect(insertText).toHaveBeenNthCalledWith(2, '[[');
  });

  it('asks which to-do to embed instead of guessing', async () => {
    const d = deps();
    await find(createJournalSlashCommands(d), 'journal.embed-todo').action({ insertText: vi.fn() });
    expect(d.pickTodo).toHaveBeenCalledTimes(1);
  });

  it('sets the mood, one command per mood', async () => {
    const d = deps();
    const cmds = createJournalSlashCommands(d);
    await find(cmds, 'journal.mood-5').action({ insertText: vi.fn() });
    await find(cmds, 'journal.mood-1').action({ insertText: vi.fn() });
    expect(d.setMood.mock.calls).toEqual([[5], [1]]);
    expect(find(cmds, 'journal.mood-4').label).toBe('Mood: Good');
  });
});
