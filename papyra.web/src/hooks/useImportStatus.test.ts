import { describe, expect, it } from 'vitest';
import { importSummary, type ImportStatus } from './useImportStatus';

const status = (over: Partial<ImportStatus>): ImportStatus => ({
  jobId: 'j', provider: 'obsidian', processed: 0, total: 0, done: true, error: null,
  imported: 0, updated: 0, unchanged: 0, skipped: 0, ...over,
});

describe('importSummary', () => {
  it('talks about notes for a notes import', () => {
    expect(importSummary(status({ imported: 3, unchanged: 1 })))
      .toBe('Import finished: 3 new notes, 1 note already here and identical — not imported again.');
  });

  it('talks about days for a journal, and says the import goes beneath what was written', () => {
    expect(importSummary(status({ provider: 'dayone', imported: 1, updated: 2, unchanged: 1, skipped: 3 })))
      .toBe('Import finished: 1 new day, 2 days already had writing — the import was added beneath it, '
        + '1 day already here — not added again, 3 left out (locked, in the Trash, not begun yet, or nothing in it).');
  });

  it('reports a failure plainly, whatever it was importing', () => {
    expect(importSummary(status({ provider: 'journal', error: 'No Journal.json' }))).toBe('Import failed: No Journal.json');
  });
});
