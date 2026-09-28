import type { BackupSummary } from '../hooks/useGitSync';

/** "12 notes, 3 to-do lists, 1 locked note, 40 attachments". */
export function summaryLine(s: BackupSummary): string {
  const parts = [
    `${s.counts.notes} note${s.counts.notes === 1 ? '' : 's'}`,
    `${s.counts.todos} to-do list${s.counts.todos === 1 ? '' : 's'}`,
    `${s.counts.vault} locked note${s.counts.vault === 1 ? '' : 's'}`,
    `${s.counts.media} attachment${s.counts.media === 1 ? '' : 's'}`,
  ];
  return parts.join(', ');
}
