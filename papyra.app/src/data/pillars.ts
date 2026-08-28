// The six things Papyra is, in the order a newcomer should meet them.
//
// Titles are taken from the app's own "How Papyra works" sheet
// (papyra.web/src/components/HelpSheet.tsx) wherever one exists, so the website
// and the product describe themselves in the same words. Every capability listed
// here ships today — v1.0 is complete and v2.0 is all but one checkbox.

export interface Pillar {
  slug: string;
  href: string;
  title: string;
  blurb: string;
  /** Short, concrete capability names for the card's footer line. */
  points: string[];
}

export const PILLARS: Pillar[] = [
  {
    slug: 'files',
    href: '/features/files/',
    title: 'Your notes are ordinary files',
    blurb:
      'Each note is a plain Markdown file with a YAML header, in a folder on your server. Copy it, back it up, or open it in another app — Papyra watches the folder and picks up whatever changed.',
    points: ['Markdown + frontmatter', 'Atomic writes', 'Obsidian-compatible'],
  },
  {
    slug: 'saving',
    href: '/features/saving/',
    title: 'There is no save button',
    blurb:
      'Edits are written a second and a half after you stop typing, and the label above the note tells you the moment they are safely stored. Older versions are kept, so you can scrub back through a note as it was.',
    points: ['Autosave', 'Snapshots', 'Time machine', 'Conflict resolver'],
  },
  {
    slug: 'offline',
    href: '/features/offline/',
    title: 'It keeps working offline',
    blurb:
      'With the server unreachable, Papyra still opens, still shows your notes and still takes edits. They queue on the device and upload themselves the moment the server is back.',
    points: ['Installable app', 'Write queue', 'Automatic replay'],
  },
  {
    slug: 'search',
    href: '/features/search/',
    title: 'Search it, then ask it',
    blurb:
      'Full-text search over every note, plus meaning-based search that finds the note you were thinking of. Then ask a question and get an answer drawn from your own writing, with citations you can open.',
    points: ['Lucene index', 'Semantic search', 'Local AI', 'Cited answers'],
  },
  {
    slug: 'sharing',
    href: '/features/sharing/',
    title: 'Share a note, mention a person',
    blurb:
      'Send a link that expires, or share directly with someone on your server. Name a colleague with @ and the block you mentioned them in lands in their inbox. Link notes to each other with double brackets.',
    points: ['Expiring links', 'Wiki links', 'Backlinks', '@mentions'],
  },
  {
    slug: 'security',
    href: '/features/security/',
    title: 'Yours, and only yours',
    blurb:
      'Every account is sealed inside its own folder. Lock a note behind your fingerprint, sign in through your company identity provider, and let Papyra keep encrypted backups and a git mirror for you.',
    points: ['Passkey vault', 'SSO', 'Encrypted backups', 'Git mirror'],
  },
];
