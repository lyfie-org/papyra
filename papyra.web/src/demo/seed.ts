// The vault a demo visitor lands in.
//
// Curated rather than random: between them these notes exercise every pillar the
// website advertises — wiki links that resolve to real backlinks, a checklist,
// an @mention, a locked note, colours, a pinned note, one archived and one
// trashed — so a visitor who pokes at anything finds it actually works.

import type { Note } from '../types/note';
import type { Category } from '../hooks/useCategories';
import type { InboxEntry } from '../hooks/useInbox';
import type { SmartCollection } from '../hooks/useCollections';

export const DEMO_USER = {
  id: 1,
  username: 'you',
  name: 'You',
  email: 'you@example.com',
  // Admin so every Settings tab — including SSO, Email, AI and Jobs — is
  // browsable. A demo that hides half its own settings undersells the product.
  role: 'Admin',
};

/** Ages the seed relative to the visit, so nothing reads as stale. */
const daysAgo = (days: number, hour = 10): string => {
  const d = new Date();
  d.setDate(d.getDate() - days);
  d.setHours(hour, (days * 7) % 60, 0, 0);
  return d.toISOString();
};

const note = (n: Partial<Note> & Pick<Note, 'id' | 'title' | 'body'>): Note => ({
  tags: [],
  color: null,
  pinned: false,
  archived: false,
  kind: 'note',
  trashed: false,
  trashedAt: null,
  secure: false,
  updated: daysAgo(3),
  ...n,
});

export const SEED_NOTES: Note[] = [
  note({
    id: 'welcome',
    title: 'Start here',
    pinned: true,
    color: '#dfe9df',
    tags: ['papyra'],
    updated: daysAgo(0, 9),
    body: `This is a real copy of Papyra running entirely inside your browser. There is no server behind it — every note here lives on your device and nothing you type is sent anywhere.

## Things worth trying

- Edit this note. Watch the label above it: there is no save button.
- Press **Ctrl+K** (or **⌘K**) and search for *revenue*.
- Open [[revenue-model]], then look at the **Linked mentions** at the bottom.
- Click the spark icon in the toolbar and ask *what did I decide about pricing?*
- Drag a card to reorder it, then reload the page.
- Switch to **To Do**, **Categories**, **Vault** and **Settings** in the sidebar.

## What is different here

The real Papyra stores each of these as a \`.md\` file on your own server and keeps a search index, snapshots and a sync engine beside them. Importing, exporting, backups and passkeys need that server, so those buttons will politely tell you they are unavailable.

Everything else you see is the actual application.`,
  }),
  note({
    id: 'revenue-model',
    title: 'Revenue model',
    tags: ['work', 'planning'],
    color: '#ece3cf',
    updated: daysAgo(1, 15),
    body: `Three tiers, priced off seats rather than storage — storage is cheap and punishing people for writing more is a strange thing for a notes company to do.

| Tier | Seats | Monthly |
| --- | --- | --- |
| Solo | 1 | Free, self-hosted |
| Team | up to 20 | $6 / seat |
| Org | unlimited | $9 / seat |

## Pricing decision

We settled on per-seat because it is the only number a buyer can predict a year out. Usage-based pricing tested badly: nobody could answer "what will this cost me in March".

Open question for [[quarterly-review]]: does the Team tier need an annual option before launch?`,
  }),
  note({
    id: 'quarterly-review',
    title: 'Quarterly review',
    tags: ['work', 'planning'],
    pinned: true,
    updated: daysAgo(2, 11),
    body: `Pull the numbers from [[revenue-model]] before Thursday.

## Agenda

1. What actually shipped
2. What slipped, and why it slipped
3. One thing to stop doing

Ask @dana for the support figures — she has the ticket volume broken down by tier.`,
  }),
  note({
    id: 'reading-list',
    title: 'Reading list',
    tags: ['personal'],
    color: '#d8e3ea',
    updated: daysAgo(5, 20),
    body: `Things worth finishing, roughly in order of how long they have been sitting here.

- *The Design of Everyday Things* — Norman
- *Thinking in Systems* — Meadows
- *A Pattern Language* — Alexander

The Alexander is the one I keep coming back to. It is not really about buildings.`,
  }),
  note({
    id: 'sourdough',
    title: 'Sourdough, finally working',
    tags: ['personal', 'recipes'],
    color: '#ecdcd0',
    updated: daysAgo(8, 8),
    body: `The change that fixed it was nothing to do with the flour.

## Method

- 100 g starter, fed the night before and used at its peak
- 350 g water at 32 °C
- 500 g bread flour
- 10 g salt, held back until after the first fold

Autolyse for an hour. Four sets of folds, thirty minutes apart. Then cold-proof in the fridge overnight — that is the part I had been skipping.

Bake at 250 °C in a covered pot for 20 minutes, then 25 more with the lid off.`,
  }),
  note({
    id: 'deploy-runbook',
    title: 'Deploy runbook',
    tags: ['work'],
    updated: daysAgo(4, 17),
    body: `The whole thing is one container plus a model sidecar.

\`\`\`bash
docker compose -f docker-compose.hub.yml pull
docker compose -f docker-compose.hub.yml up -d
docker compose logs -f papyra
\`\`\`

Health check is on \`/health\`. If it answers, the vault reconciled cleanly at boot — the cold-boot diff runs before the port opens, so a green health check means disk and cache already agree.

Roll back by pinning the previous tag instead of \`latest\`.`,
  }),
  note({
    id: 'garden',
    title: 'What went in the beds',
    tags: ['personal'],
    color: '#dde7d4',
    updated: daysAgo(12, 16),
    body: `North bed gets sun until about two, so the tomatoes went there and the chard went in the shade of the wall.

- Tomatoes — four plants, staked
- Chard, which apparently cannot be killed
- Basil, which apparently can

Note for next year: start the basil indoors, it never recovered from going straight out.`,
  }),
  note({
    id: 'weekly-todo',
    title: 'This week',
    kind: 'todo',
    tags: ['work'],
    updated: daysAgo(0, 14),
    body: `- [x] Send the quarterly numbers to Dana
- [x] Renew the domain
- [ ] Write up the pricing decision in [[revenue-model]]
- [ ] Book the dentist
- [ ] Reply to the conference email`,
  }),
  note({
    id: 'groceries',
    title: 'Groceries',
    kind: 'todo',
    color: '#ecd9da',
    updated: daysAgo(1, 18),
    body: `- [x] Bread flour
- [ ] Olive oil
- [ ] Coffee
- [ ] Something for Thursday`,
  }),
  note({
    id: 'passport-details',
    title: 'Travel documents',
    secure: true,
    tags: ['personal'],
    updated: daysAgo(30, 12),
    body: '',
  }),
  note({
    id: 'old-standup-notes',
    title: 'Standup notes, Q1',
    archived: true,
    tags: ['work'],
    updated: daysAgo(120, 9),
    body: `Kept for the record rather than for reading. Archived notes stay searchable and stay on disk — archiving is about getting something off the desk, not about hiding it.

Week 3 was the one where the sync engine ate its own tail. The write-ring came out of that.`,
  }),
  note({
    id: 'scratch',
    title: 'Untitled thought',
    trashed: true,
    trashedAt: daysAgo(2, 13),
    updated: daysAgo(2, 13),
    body: `Half a sentence about something that seemed important at the time.

Trash keeps a note for 30 days by default, so this is recoverable until it isn't. Change that in Settings → Data & Storage.`,
  }),
];

export const SEED_CATEGORIES: Category[] = [
  { name: 'work', color: '#ece3cf', count: 5 },
  { name: 'personal', color: '#d8e3ea', count: 4 },
  { name: 'planning', color: '#dfe9df', count: 2 },
  { name: 'recipes', color: '#ecdcd0', count: 1 },
  { name: 'papyra', color: null, count: 1 },
];

export const SEED_COLLECTIONS: SmartCollection[] = [
  {
    id: 1,
    name: 'Pinned work',
    rulesJson: JSON.stringify({
      match: 'all',
      conditions: [
        { field: 'tag', value: 'work' },
        { field: 'pinned', value: 'true' },
      ],
    }),
    createdUtc: daysAgo(40),
  },
  {
    id: 2,
    name: 'Anything about pricing',
    rulesJson: JSON.stringify({
      match: 'any',
      conditions: [{ field: 'text', value: 'pricing' }],
    }),
    createdUtc: daysAgo(20),
  },
];

export const SEED_INBOX: InboxEntry[] = [
  {
    id: 1,
    noteId: 'revenue-model',
    blockId: 'demo-block-1',
    from: 'dana',
    receivedUtc: daysAgo(1, 12),
    title: 'Support volume by tier',
    text: 'Team accounts open about a third of the tickets and are a fifth of the seats. Worth a line in the review.',
    readUtc: null,
  },
];

/**
 * Scripted answers for the assistant.
 *
 * The real thing runs a retrieval pass over embeddings and streams a model's
 * tokens back. There is no model in a browser tab, so these are written answers
 * keyed on what the notes actually say — with citations that open the real note.
 * Anything off-script gets the fallback, which says plainly that it is a demo.
 */
export interface ScriptedAnswer {
  /** Any one of these substrings in the question selects this answer. */
  match: string[];
  answer: string;
  citations: { noteId: string; title: string; snippet: string; score: number }[];
}

export const CHAT_SCRIPT: ScriptedAnswer[] = [
  {
    match: ['pricing', 'price', 'revenue', 'tier', 'cost'],
    answer:
      'You settled on per-seat pricing, in three tiers: Solo is free and self-hosted, Team is $6 per seat for up to 20 seats, and Org is $9 per seat with no limit.\n\nThe reasoning in your notes is that per-seat is the only number a buyer can predict a year out — usage-based pricing tested badly because nobody could answer "what will this cost me in March". You deliberately priced on seats rather than storage, on the grounds that punishing people for writing more is a strange thing for a notes company to do.\n\nThere is still one open question flagged for the quarterly review: whether the Team tier needs an annual option before launch.',
    citations: [
      {
        noteId: 'revenue-model',
        title: 'Revenue model',
        snippet:
          'We settled on per-seat because it is the only number a buyer can predict a year out. Usage-based pricing tested badly…',
        score: 0.91,
      },
      {
        noteId: 'quarterly-review',
        title: 'Quarterly review',
        snippet: 'Pull the numbers from [[revenue-model]] before Thursday.',
        score: 0.62,
      },
    ],
  },
  {
    match: ['deploy', 'docker', 'container', 'rollback', 'roll back', 'install'],
    answer:
      'Your runbook says the whole deployment is one container plus a model sidecar. You pull, bring it up detached, and follow the logs:\n\n```\ndocker compose -f docker-compose.hub.yml pull\ndocker compose -f docker-compose.hub.yml up -d\n```\n\nThe health check is on `/health`, and your note makes a point of what a green check means: the cold-boot diff runs before the port opens, so if it answers at all, disk and cache already agree.\n\nTo roll back, pin the previous tag instead of `latest`.',
    citations: [
      {
        noteId: 'deploy-runbook',
        title: 'Deploy runbook',
        snippet:
          'Health check is on /health. If it answers, the vault reconciled cleanly at boot…',
        score: 0.94,
      },
    ],
  },
  {
    match: ['week', 'todo', 'to do', 'task', 'outstanding', 'left to do'],
    answer:
      'Three things are still open this week: writing up the pricing decision in your revenue note, booking the dentist, and replying to the conference email.\n\nYou have already sent the quarterly numbers to Dana and renewed the domain.\n\nSeparately, your groceries list still has olive oil, coffee and "something for Thursday" on it.',
    citations: [
      {
        noteId: 'weekly-todo',
        title: 'This week',
        snippet: '- [ ] Write up the pricing decision in [[revenue-model]]',
        score: 0.88,
      },
      {
        noteId: 'groceries',
        title: 'Groceries',
        snippet: '- [ ] Olive oil\n- [ ] Coffee',
        score: 0.55,
      },
    ],
  },
  {
    match: ['sourdough', 'bread', 'bake', 'recipe', 'dough'],
    answer:
      'The thing that finally fixed your sourdough was not the flour — it was the overnight cold proof in the fridge, which you had been skipping.\n\nThe rest of the method: 100 g starter fed the night before and used at its peak, 350 g water at 32 °C, 500 g bread flour, and 10 g salt held back until after the first fold. Autolyse an hour, then four sets of folds thirty minutes apart. Bake at 250 °C covered for 20 minutes, then 25 more with the lid off.',
    citations: [
      {
        noteId: 'sourdough',
        title: 'Sourdough, finally working',
        snippet: 'The change that fixed it was nothing to do with the flour.',
        score: 0.96,
      },
    ],
  },
  {
    match: ['garden', 'tomato', 'basil', 'plant', 'bed'],
    answer:
      'Your north bed gets sun until about two, so the tomatoes went there — four plants, staked — and the chard went in the shade of the wall.\n\nThe note you left for yourself: start the basil indoors next year. It never recovered from going straight out.',
    citations: [
      {
        noteId: 'garden',
        title: 'What went in the beds',
        snippet: 'Note for next year: start the basil indoors, it never recovered…',
        score: 0.93,
      },
    ],
  },
];

export const CHAT_FALLBACK =
  'I can only answer from the notes in this vault, and this browser demo runs on a short script rather than a real language model — so I do not have an answer for that one.\n\nTry asking about **pricing**, **deploying Papyra**, **what is left this week**, **sourdough**, or **the garden**. On a real Papyra server this question would go to your own model, with the notes it retrieved cited underneath.';
