// The /roadmap page: every release that mattered, with the one feature it is
// remembered for, and what is planned next.
//
// Shipped entries come from CHANGELOG.md and .github/release-notes. Planned
// entries come from .claude/V1_X_IMPLEMENTATION_PLAN.md and the mobile and
// desktop plans. They are plans, not promises: the page says so, and gives a
// season rather than a day, so a slipped release never makes the page wrong.
//
// The home page shows the same data, shortened: releases from 1.0 onwards and the
// plans flagged `home`, with a button that leads here.

import type { IconName } from '../lib/icons';

export interface Release {
  /** ISO date the release went out. */
  date: string;
  /** Tag without the leading "v". Every entry here still exists on GitHub. */
  version: string;
  icon: IconName;
  /** The feature this release is remembered for. */
  title: string;
  text: string;
  /** A few smaller things that shipped alongside it. */
  also?: string[];
  /** Rendered as the highlighted head of the timeline. */
  current?: boolean;
}

/** Newest first. */
export const RELEASES: Release[] = [
  {
    date: '2026-10-29',
    version: '1.1.0',
    icon: 'book',
    title: 'The journal',
    text: 'A page for each day, with moods, a calendar, photos, voice notes and days you can lock. Import from Day One.',
    also: ['Export the journal to Markdown or PDF', 'Locked days listed in the Vault, by date only'],
    current: true,
  },
  {
    date: '2026-10-16',
    version: '1.0.0',
    icon: 'rocket',
    title: 'Papyra 1.0',
    text: 'The first stable release. The file format, the data layout and the upgrade path are stable from here on.',
    also: ['Agents using an API key can edit a live note', 'Sharing with people or by link, with expiry', 'Passes WCAG 2.2 AA checks on every change'],
  },
  {
    date: '2026-10-09',
    version: '0.4.0',
    icon: 'globe',
    title: 'Embed any link',
    text: 'Maps, songs, videos and documents shown inside a note, with document cards that look like they do on your desktop.',
    also: ['An admin Logs page', 'Tables you can select, drag and copy'],
  },
  {
    date: '2026-10-01',
    version: '0.3.0',
    icon: 'search',
    title: 'Search inside attachments',
    text: 'Text read out of scanned images and audio recordings becomes part of search. Locked notes are never indexed.',
    also: ['Export includes every picture, video and file', 'Proper thumbnails for iPhone photos'],
  },
  {
    date: '2026-09-29',
    version: '0.2.0',
    icon: 'users',
    title: 'Live collaboration',
    text: 'Edit a shared note together, with live cursors, presence and your own undo. Comment threads on any text.',
    also: ['Shared notes open offline', 'Restoring an old version while others edit'],
  },
  {
    date: '2026-08-07',
    version: '0.1.0',
    icon: 'link',
    title: 'Locked notes and single sign-on',
    text: 'Notes locked behind a passkey, a time machine for a note’s past versions, and sign-in with OpenID Connect.',
    also: ['Backlinks and focus mode', 'Search inside images and audio'],
  },
  {
    date: '2026-06-17',
    version: '0.0.1',
    icon: 'box',
    title: 'First release',
    text: 'Markdown files, full-text search and autosave in one Docker container.',
  },
];

export interface Plan {
  icon: IconName;
  title: string;
  text: string;
  /** A season, not a day. */
  when: string;
  /** The very next release, drawn with more weight. */
  next?: boolean;
  /** Also shown in the short list on the home page. */
  home?: boolean;
}

/**
 * What is planned, in the order it is planned to arrive: the nearest first.
 * (The page draws the timeline with the furthest at the top, like the home page.)
 */
export const PLANS: Plan[] = [
  {
    icon: 'bell',
    title: 'Notifications where you already are',
    text: 'Mentions, shares and backup news through ntfy, Discord or Telegram, a backup of the server itself, and a journal you can switch off.',
    when: 'Next release',
    next: true,
    home: true,
  },
  {
    icon: 'list-check',
    title: 'To-do due dates and reminders',
    text: 'Give a to-do a date, see what is due, and be reminded by email or any connected place. The date is plain text on the line, so any editor can read it.',
    when: 'Early 2027',
  },
  {
    icon: 'download',
    title: 'Web clipper',
    text: 'Save a page, a selection or a bookmark from your browser in two clicks, as a clean Markdown note, including pages behind a login.',
    when: 'Early 2027',
  },
  {
    icon: 'message',
    title: 'Capture by message',
    text: 'Message your own Telegram, Discord or ntfy bot to add a note, a link or a to-do. No app to install and no public address needed.',
    when: 'Spring 2027',
  },
  {
    icon: 'sparkles',
    title: 'Voice to text',
    text: 'Turn a recording into text on your own server with a local model, or through an endpoint you choose.',
    when: 'Spring 2027',
  },
  {
    icon: 'pen',
    title: 'Proofreading as you write',
    text: 'Wavy underlines for spelling and grammar with one-click fixes. It runs in your browser and never changes your text until you accept.',
    when: 'Spring 2027',
  },
  {
    icon: 'code',
    title: 'Connect an AI app to your notes',
    text: 'An MCP server, so Claude Desktop, Cursor and others can search and read your notes, add to today’s journal or tick a to-do. Papyra runs no AI itself.',
    when: 'Spring 2027',
  },
  {
    icon: 'image',
    title: 'Photos from Immich',
    text: 'Connect your own Immich and see that day’s photos beside the journal page. One click copies chosen ones into the day so they stay.',
    when: 'Summer 2027',
  },
  {
    icon: 'play',
    title: 'What you watched, from Jellyfin and Plex',
    text: 'A “what I watched today” log in the journal, saved as plain Markdown with poster thumbnails.',
    when: 'Summer 2027',
  },
  {
    icon: 'smartphone',
    title: 'Mobile app',
    text: 'Android first, then iOS: widgets, a share sheet, quick capture and reliable offline use, alongside the web app.',
    when: 'Later',
    home: true,
  },
  {
    icon: 'monitor',
    title: 'Desktop app',
    text: 'Windows, macOS and Linux, connecting to your server.',
    when: 'Later',
    home: true,
  },
];
