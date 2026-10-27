// The days a visitor lands on in the demo journal. No store import: the store seeds from here.

import type { JournalPrefs, JournalTemplate, Mood } from '../types/journal';
import { addDays, todayIn } from '../lib/journalDay';

/** One day as the demo keeps it. A day with no record is a day nobody has written. */
export interface DemoDay {
  body: string;
  mood: Mood | null;
  tags: string[];
  locked: boolean;
  archived: boolean;
  trashed: boolean;
  trashedAt: string | null;
  updated: string;
}



const OFFSET_WORDS: [number, Mood, string, string[]][] = [
  [1, 4, 'Slow morning, then the long walk by the river. The light was low and gold the whole way home.\n\n- [ ] book flights\n- [x] call mum', ['walk']],
  [2, 3, 'A grey day. Spent most of it on the quarterly numbers; ended with soup and nothing else.', ['work']],
  [3, 5, 'Finished the draft. Told nobody yet, just sat with it for an hour, which felt right.', ['work', 'writing']],
  [4, 4, 'Coffee with Priya. We talked about the move and neither of us said the obvious thing.', ['people']],
  [5, 3, 'A locked day: the page keeps its date, its mood and its size, and not a word more.', []],
  [6, 2, 'Slept badly. Everything was a little louder than it needed to be.', []],
  [8, 4, 'Market in the rain. Bought too many plums and was not sorry.', ['walk']],
  [9, 3, 'Tidied the desk. Put the old notebooks in a box, which is a kind of decision.', []],
  [11, 5, 'Sea air. Nothing to do and time to do it in.', ['trip']],
  [12, 1, 'A rough one. Writing it down so it can stay here.', []],
  [14, 3, 'Reread last month. Mostly I want to be kinder to the person who wrote it.', []],
  [16, 4, 'Dinner at the long table. Four conversations at once and I caught all of them.', ['people']],
  [19, 3, 'Rain on the skylight; worked with it on.', ['work']],
  [21, 4, 'Ran further than I meant to and the day got better for it.', ['run']],
  [24, 5, 'The good news arrived at lunch. Walked it off, twice around the park.', ['walk']],
  [28, 2, 'Low battery. Early night.', []],
];

/** Days in the demo vault, dated relative to the visit so it never reads as stale. */
export function seedJournal(): Record<string, DemoDay> {
  const now = todayIn(new Date(), undefined, 0);
  const iso = (daysBack: number, hour: number) => {
    const d = new Date();
    d.setDate(d.getDate() - daysBack);
    d.setHours(hour, (daysBack * 11) % 60, 0, 0);
    return d.toISOString();
  };
  const out: Record<string, DemoDay> = {};
  for (const [back, mood, body, tags] of OFFSET_WORDS) {
    out[addDays(now, -back)] = {
      body, mood, tags, locked: back === 5, archived: false, trashed: false, trashedAt: null, updated: iso(back, 21),
    };
  }
  out[addDays(now, -10)] = {
    body: 'Cleared out the spare room. Kept the lamp.', mood: 3, tags: [], locked: false, archived: true,
    trashed: false, trashedAt: null, updated: iso(10, 20),
  };
  out[addDays(now, -13)] = {
    body: 'A page I changed my mind about.', mood: null, tags: [], locked: false, archived: false,
    trashed: true, trashedAt: iso(2, 9), updated: iso(13, 20),
  };
  // A year ago today, for "On this day".
  const lastYear = new Date(); lastYear.setFullYear(lastYear.getFullYear() - 1);
  out[todayIn(lastYear, undefined, 0)] = {
    body: 'First week at the new desk. Everything still smells of paint, and I like it.', mood: 4, tags: ['work'],
    locked: false, archived: false, trashed: false, trashedAt: null, updated: lastYear.toISOString(),
  };
  return out;
}

export const SEED_JOURNAL_PREFS: JournalPrefs = {
  dayStartsAt: 0, lockNewEntries: false, promptsOn: true, hideStreak: false,
  reminderOn: false, reminderTime: null, defaultTemplate: null,
};

export const SEED_JOURNAL_TEMPLATES: JournalTemplate[] = [
  { name: 'Evening review', body: '## {{weekday}}\n\nOne good thing:\n\nOne thing I would change:\n\nTomorrow:\n- [ ] \n' },
];
