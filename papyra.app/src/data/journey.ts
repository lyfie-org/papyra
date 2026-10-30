// The road so far, newest first, for the timeline on the home page.
//
// Dates come from CHANGELOG.md and the git history: each entry is the day a
// feature first shipped. Approximate on purpose — a milestone usually landed
// over a few commits — so dates are shown to the day only where they are certain.
//
// `version` is set only where that release still exists on GitHub. Most of the
// 0.x patch releases were test builds and have been removed, so milestones that
// first shipped in one of those show their date without a release link.

import type { IconName } from '../lib/icons';

export interface Milestone {
  /** ISO date the feature went out. */
  date: string;
  /** The tag it first shipped in, without the leading "v". Only for releases that still exist. */
  version?: string;
  icon: IconName;
  title: string;
  text: string;
  /** Rendered as the highlighted head of the timeline. */
  current?: boolean;
  /** A commit to link instead of a release, e.g. the very first one. */
  commit?: string;
}

export const JOURNEY: Milestone[] = [
  {
    date: '2026-10-29',
    version: '1.1.0',
    icon: 'book',
    title: 'The journal',
    text: 'A page for each day, with moods, a calendar, photos, voice notes and days you can lock. Import from Day One.',
    current: true,
  },
  {
    date: '2026-10-16',
    version: '1.0',
    icon: 'rocket',
    title: 'Papyra 1.0',
    text: 'The first stable release, with everything listed below.',
  },
  {
    date: '2026-10-13',
    icon: 'code',
    title: 'Agents can edit notes',
    text: 'Scripts and AI agents using an API key can edit a live note while you have it open.',
  },
  {
    date: '2026-10-09',
    version: '0.4.0',
    icon: 'globe',
    title: 'Embed any link',
    text: 'Maps, songs, videos and documents shown inside a note.',
  },
  {
    date: '2026-10-06',
    icon: 'smartphone',
    title: 'Installable app',
    text: 'Install it on your phone. Edits made offline sync when you reconnect.',
  },
  {
    date: '2026-10-01',
    icon: 'lock',
    title: 'Locked notes, encrypted at rest',
    text: 'Vault notes are encrypted on disk, not just hidden on screen.',
  },
  {
    date: '2026-09-30',
    icon: 'image',
    title: 'Pictures, PDFs and video',
    text: 'Drop files into a note. PDFs preview in place, and iPhone photos work too.',
  },
  {
    date: '2026-09-29',
    version: '0.2.0',
    icon: 'users',
    title: 'Live collaboration',
    text: 'Edit a shared note together, with live cursors, presence and your own undo. Comment threads on any text.',
  },
  {
    date: '2026-09-28',
    icon: 'key',
    title: 'Passkeys and two-step sign-in',
    text: 'Sign in with a fingerprint. Every account can use authenticator codes.',
  },
  {
    date: '2026-09-27',
    icon: 'bell',
    title: 'Sharing, mentions, notifications',
    text: '@mention someone to share a note. A tray shows what changed.',
  },
  {
    date: '2026-09-25',
    icon: 'upload',
    title: 'Import from Google Keep and Obsidian',
    text: 'Bring your notes across. Importing again never duplicates a note.',
  },
  {
    date: '2026-08-07',
    version: '0.1.0',
    icon: 'link',
    title: 'Backlinks, focus mode and SSO',
    text: 'See every note that links to this one, and write with nothing else on screen.',
  },
  {
    date: '2026-06-17',
    version: '0.0.1',
    icon: 'box',
    title: 'First release',
    text: 'Markdown files, full-text search and autosave in one Docker container.',
  },
  {
    date: '2026-06-01',
    icon: 'flag',
    title: 'Day one',
    text: 'The first commit.',
    commit: 'eb5ac36cf8348caab8e852d1bb08992700a2cab6',
  },
];

/** Coming soon — plans, not promises. In order: the next big thing first. */
export const NEXT: { icon: IconName; title: string; text: string; next?: boolean }[] = [
  { icon: 'smartphone', title: 'Mobile app', text: 'iOS and Android, with offline support.' },
  { icon: 'monitor', title: 'Desktop app', text: 'Windows, macOS and Linux, connecting to your server.' },
];
