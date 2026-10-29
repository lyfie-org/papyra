// The journal API's shapes (`/api/journal`). A journal day is a `yyyy-MM-dd`
// string — see lib/journalDay.

/** 1 = Rough … 5 = Great. */
export type Mood = 1 | 2 | 3 | 4 | 5;

/** One day. `exists: false` is a day nobody has written yet (an empty page, no file). */
export interface JournalEntry {
  date: string;
  id: string;
  exists: boolean;
  /** A day that hasn't begun: it can be looked at, never written. */
  future: boolean;
  /** The journal's idea of today (the server's, in the person's time zone). */
  today: string;
  /** Empty for a locked entry until it is opened with the vault. */
  body: string;
  mood: Mood | null;
  tags: string[];
  archived: boolean;
  locked: boolean;
  trashed: boolean;
  words: number;
  updated: string | null;
}

/** A day on a calendar or in a list — enough to draw it, never the text of a locked one. */
export interface JournalSummary {
  date: string;
  mood: Mood | null;
  tags: string[];
  words: number;
  hasMedia: boolean;
  locked: boolean;
  archived: boolean;
  trashed: boolean;
  cover: string | null;
  excerpt: string | null;
  updated: string;
  /** When a day went to the Trash (only on a trashed one). */
  trashedAt?: string | null;
}

/** A page a day can start from. */
export interface JournalTemplate {
  name: string;
  body: string;
}

export interface JournalStats {
  current: number;
  longest: number;
  totalDays: number;
  totalWords: number;
  thisMonth: number;
  todayWritten: boolean;
  streakEndsOn: string | null;
}

export interface JournalPrefs {
  dayStartsAt: number;
  lockNewEntries: boolean;
  promptsOn: boolean;
  hideStreak: boolean;
  reminderOn: boolean;
  reminderTime: string | null;
  defaultTemplate: string | null;
}

/** What may be sent to change the preferences: any of them, or "no default template any more". */
export type JournalPrefsPatch = Partial<JournalPrefs> & { clearDefaultTemplate?: boolean };

export interface JournalToday {
  date: string;
  entry: JournalEntry;
  stats: JournalStats;
  settings: JournalPrefs;
  pinSet: boolean;
}

export interface JournalRange {
  from: string;
  to: string;
  today: string;
  entries: JournalSummary[];
}

/** What a save may carry: absent keeps, `null` mood clears. */
export interface JournalPatch {
  body?: string;
  mood?: Mood | null;
  tags?: string[];
  archived?: boolean;
  secure?: boolean;
}
