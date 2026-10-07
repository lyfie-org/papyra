// The road to v1.0, newest first, for the timeline on the home page.
//
// Dates and versions come from CHANGELOG.md and the git history: each entry is
// the release a feature first shipped in. Approximate on purpose — a milestone
// usually landed over a few commits — so dates are shown to the day only where
// they are certain.

import type { IconName } from '../lib/icons';

export interface Milestone {
  /** ISO date the release went out. */
  date: string;
  /** The tag it first shipped in, without the leading "v". */
  version?: string;
  icon: IconName;
  title: string;
  text: string;
  /** Rendered as the highlighted head of the timeline. */
  current?: boolean;
}

export const JOURNEY: Milestone[] = [
  {
    date: '2026-10-07',
    version: '1.0',
    icon: 'rocket',
    title: 'Papyra 1.0',
    text: 'Everything below — polished, tested and ready for your notes.',
    current: true,
  },
  {
    date: '2026-10-06',
    version: '0.3.6',
    icon: 'smartphone',
    title: 'An app that catches up',
    text: 'Install it on your phone; it syncs the moment you come back.',
  },
  {
    date: '2026-10-01',
    version: '0.3.2',
    icon: 'lock',
    title: 'Locked notes, encrypted at rest',
    text: 'Vault notes are sealed on disk, not only hidden on screen.',
  },
  {
    date: '2026-09-30',
    version: '0.2.6',
    icon: 'image',
    title: 'Pictures, PDFs and video',
    text: 'Drop files into a note; preview PDFs in place, iPhone photos included.',
  },
  {
    date: '2026-09-29',
    version: '0.2.0',
    icon: 'users',
    title: 'Live collaboration',
    text: 'Edit a shared note together — live cursors, presence, your own undo.',
  },
  {
    date: '2026-09-29',
    version: '0.2.5',
    icon: 'message',
    title: 'Comments',
    text: 'Highlight a sentence, leave a thought, reply in threads.',
  },
  {
    date: '2026-09-28',
    version: '0.1.19',
    icon: 'key',
    title: 'Passkeys and two-step sign-in',
    text: 'Sign in with a fingerprint; authenticator codes for every account.',
  },
  {
    date: '2026-09-28',
    version: '0.1.23',
    icon: 'git',
    title: 'Encrypted GitHub backup',
    text: 'A guided first run, and backups pushed to a private repo.',
  },
  {
    date: '2026-09-27',
    version: '0.1.17',
    icon: 'bell',
    title: 'Sharing, mentions, notifications',
    text: '@mention someone to share a note; a tray tells you what changed.',
  },
  {
    date: '2026-09-25',
    version: '0.1.9',
    icon: 'upload',
    title: 'Import from Google Keep and Obsidian',
    text: 'Bring everything across; re-importing never duplicates a note.',
  },
  {
    date: '2026-09-25',
    version: '0.1.8',
    icon: 'history',
    title: 'Version history in the editor',
    text: 'Scrub back through every distinct version of a note.',
  },
  {
    date: '2026-09-24',
    version: '0.1.6',
    icon: 'shield',
    title: 'The vault',
    text: 'A PIN — or your face or fingerprint — opens your locked notes.',
  },
  {
    date: '2026-09-22',
    version: '0.1.3',
    icon: 'globe',
    title: 'papyra.app and the live demo',
    text: 'The real app, running entirely in your browser.',
  },
  {
    date: '2026-08-07',
    version: '0.1.0',
    icon: 'link',
    title: 'Backlinks, focus mode and SSO',
    text: 'See every note that links here; write with nothing else on screen.',
  },
  {
    date: '2026-06-17',
    version: '0.0.1',
    icon: 'box',
    title: 'First release',
    text: 'Markdown files, full-text search, autosave — in one Docker container.',
  },
  {
    date: '2026-06-01',
    icon: 'flag',
    title: 'Day one',
    text: 'The first commit.',
  },
];
