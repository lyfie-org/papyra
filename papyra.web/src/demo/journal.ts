// The journal, in a browser tab: the same shapes the server answers with, over the
// demo's own state. A day here is just a body, a mood and a few flags; everything
// the page asks of `/api/journal` (today, a month, the streak, on this day, the bin,
// templates, preferences) is derived from those, so the calendar, the streak and the
// mood line are the real components looking at believable data.

import type {
  JournalEntry, JournalPrefs, JournalStats, JournalSummary, JournalTemplate, Mood,
} from '../types/journal';
import { addDays, compareDays, isDay, todayIn, type Day } from '../lib/journalDay';
import { countWords } from '../lib/journalText';
import { getState, mutate } from './store';
import type { DemoDay } from './journalSeed';
import type { Route } from './backend';


const json = (data: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...headers } });

const error = (message: string, code: string, status: number) => json({ error: message, code }, status);

/** The demo's idea of today: the visitor's own clock and zone, with the preferred day start. */
const today = (): Day => todayIn(new Date(), undefined, getState().journalPrefs.dayStartsAt);

const wordsOf = (d: DemoDay): number => (d.body.trim() ? countWords(d.body) : 0);

/** The text of a locked day is withheld unless the request carries an unlock token (any PIN opens the demo). */
const revealed = (request: Request): boolean => !!request.headers.get('X-Unlock-Token');

const etagOf = (body: string): string => {
  let h = 0;
  for (let i = 0; i < body.length; i++) h = (h * 31 + body.charCodeAt(i)) | 0;
  return `"${(h >>> 0).toString(16)}-${body.length}"`;
};

function dto(date: Day, day: DemoDay | undefined, now: Day, withBody: boolean): JournalEntry {
  return {
    date,
    id: `journal-${date}`,
    exists: !!day,
    future: compareDays(date, now) > 0,
    today: now,
    body: day && (withBody || !day.locked) ? day.body : '',
    mood: day?.mood ?? null,
    tags: day?.tags ?? [],
    archived: day?.archived ?? false,
    locked: day?.locked ?? false,
    trashed: day?.trashed ?? false,
    words: day ? wordsOf(day) : 0,
    updated: day?.updated ?? null,
  };
}

function summary(date: Day, day: DemoDay): JournalSummary {
  const cover = day.locked ? null : /!\[\[([^\]|#]+\.(?:png|jpe?g|gif|webp))/i.exec(day.body)?.[1] ?? null;
  return {
    date, mood: day.mood, tags: day.locked ? [] : day.tags, words: wordsOf(day),
    hasMedia: !day.locked && day.body.includes('![['), locked: day.locked, archived: day.archived,
    trashed: day.trashed, cover, excerpt: null, updated: day.updated,
    trashedAt: day.trashed ? day.trashedAt : null,
  };
}

const counts = (day: DemoDay): boolean => !day.trashed && (wordsOf(day) > 0 || day.mood !== null);

function statsFor(now: Day): JournalStats {
  const days = getState().journal;
  const written = Object.keys(days).filter((d) => counts(days[d])).sort();
  const set = new Set(written);

  // The streak ends today if today is written, else yesterday (today is still open).
  const todayWritten = set.has(now);
  let end: Day | null = todayWritten ? now : set.has(addDays(now, -1)) ? addDays(now, -1) : null;
  let current = 0;
  for (let d = end; d && set.has(d); d = addDays(d, -1)) current++;
  if (current === 0) end = null;

  let longest = 0;
  let run = 0;
  let prev: Day | null = null;
  for (const d of written) {
    run = prev && addDays(prev, 1) === d ? run + 1 : 1;
    longest = Math.max(longest, run);
    prev = d;
  }
  const month = now.slice(0, 7);
  return {
    current, longest, totalDays: written.length,
    totalWords: written.reduce((n, d) => n + wordsOf(days[d]), 0),
    thisMonth: written.filter((d) => d.startsWith(month)).length,
    todayWritten, streakEndsOn: end,
  };
}

function write(date: Day, patch: { body?: string; mood?: Mood | null; tags?: string[]; archived?: boolean; secure?: boolean }): DemoDay | undefined {
  return mutate((s) => {
    const prior = s.journal[date];
    const body = patch.body ?? prior?.body ?? '';
    const mood = patch.mood === undefined ? prior?.mood ?? null : patch.mood;
    // A page with no words and no mood is not a day.
    if (!prior && !body.trim() && mood === null) return undefined;
    const next: DemoDay = {
      body, mood, tags: patch.tags ?? prior?.tags ?? [],
      locked: patch.secure ?? prior?.locked ?? s.journalPrefs.lockNewEntries,
      archived: patch.archived ?? prior?.archived ?? false,
      trashed: prior?.trashed ?? false, trashedAt: prior?.trashedAt ?? null,
      updated: new Date().toISOString(),
    };
    s.journal[date] = next;
    return next;
  });
}

const openItems = (body: string): string[] => body.split('\n').filter((l) => /^\s*[-*+]\s+\[ \]\s+\S/.test(l)).map((l) => l.trimEnd());

export function journalSearchHits(query: string): { id: string; title: string; snippet: string; secure: boolean; kind: 'journal' }[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  return Object.entries(getState().journal)
    .filter(([, d]) => !d.trashed && !d.locked && d.body.toLowerCase().includes(q))
    .sort(([a], [b]) => (a < b ? 1 : -1))
    .slice(0, 6)
    .map(([date, d]) => {
      const at = d.body.toLowerCase().indexOf(q);
      const from = Math.max(0, at - 40);
      const slice = d.body.slice(from, from + 120).replace(/\s+/g, ' ');
      return { id: `journal-${date}`, title: date, snippet: `${from > 0 ? '…' : ''}${slice}`, secure: false, kind: 'journal' as const };
    });
}

type Params = { match: RegExpMatchArray; url: URL; request: Request; body: () => Promise<unknown> };
type Write = { body?: string; mood?: Mood | null; tags?: string[]; archived?: boolean; secure?: boolean };

export function journalRoutes(): Route[] {
  const entryRoute = (handler: (p: Params, date: Day) => Response | Promise<Response>) => async (p: Params) => {
    const date = p.match[1];
    return isDay(date) ? handler(p, date) : error('Dates look like 2026-10-25.', 'invalid_date', 400);
  };
  const reply = (p: Params, date: Day): Response => {
    const day = getState().journal[date];
    const body = dto(date, day, today(), revealed(p.request));
    return json(body, 200, day && (!day.locked || revealed(p.request)) ? { ETag: etagOf(day.body) } : {});
  };

  return [
    ['GET', /^\/api\/journal\/today$/, () => {
      const now = today();
      const day = getState().journal[now];
      return json({
        date: now, entry: dto(now, day, now, false), stats: statsFor(now),
        settings: getState().journalPrefs, pinSet: true,
      }, 200, day && !day.locked ? { ETag: etagOf(day.body) } : {});
    }],
    ['GET', /^\/api\/journal\/stats$/, () => json(statsFor(today()))],
    ['GET', /^\/api\/journal\/on-this-day$/, ({ url }) => {
      const date = url.searchParams.get('date') ?? today();
      const [, mm, dd] = date.split('-');
      const entries = Object.entries(getState().journal)
        .filter(([d, day]) => d.slice(5) === `${mm}-${dd}` && d < date && !day.trashed && counts(day))
        .sort(([a], [b]) => (a < b ? 1 : -1))
        .map(([d, day]) => ({ ...summary(d, day), excerpt: day.locked ? null : day.body.replace(/\s+/g, ' ').slice(0, 160) }));
      return json({ date, entries });
    }],
    ['GET', /^\/api\/journal\/settings$/, () => json({ settings: getState().journalPrefs, pinSet: true })],
    ['PUT', /^\/api\/journal\/settings$/, async ({ body }) => {
      const patch = (await body()) as Partial<JournalPrefs> & { clearDefaultTemplate?: boolean };
      const next = mutate((s) => {
        const { clearDefaultTemplate, ...rest } = patch;
        s.journalPrefs = { ...s.journalPrefs, ...rest };
        if (clearDefaultTemplate) s.journalPrefs.defaultTemplate = null;
        return s.journalPrefs;
      });
      return json({ settings: next, pinSet: true });
    }],
    ['GET', /^\/api\/journal\/templates$/, () => json({ templates: getState().journalTemplates, defaultTemplate: getState().journalPrefs.defaultTemplate })],
    ['PUT', /^\/api\/journal\/templates\/([^/]+)$/, async ({ match, body }) => {
      const name = decodeURIComponent(match[1]).trim();
      if (!/^[\p{L}\p{N}][\p{L}\p{N} _.-]{0,59}$/u.test(name)) return error('A template name uses letters, numbers, spaces, dots, dashes and underscores (60 at most).', 'invalid_name', 422);
      const text = ((await body()) as { body?: string }).body ?? '';
      const saved: JournalTemplate = { name, body: text };
      mutate((s) => {
        const at = s.journalTemplates.findIndex((t) => t.name === name);
        if (at >= 0) s.journalTemplates[at] = saved; else s.journalTemplates.push(saved);
      });
      return json(saved);
    }],
    ['DELETE', /^\/api\/journal\/templates\/([^/]+)$/, ({ match }) => {
      const name = decodeURIComponent(match[1]);
      const had = getState().journalTemplates.some((t) => t.name === name);
      if (!had) return new Response(null, { status: 404 });
      mutate((s) => {
        s.journalTemplates = s.journalTemplates.filter((t) => t.name !== name);
        if (s.journalPrefs.defaultTemplate === name) s.journalPrefs.defaultTemplate = null;
      });
      return new Response(null, { status: 204 });
    }],
    ['GET', /^\/api\/journal\/bin$/, ({ url }) => {
      const trashed = url.searchParams.get('state') === 'trashed';
      const entries = Object.entries(getState().journal)
        .filter(([, d]) => (trashed ? d.trashed : d.archived && !d.trashed))
        .sort(([a], [b]) => (a < b ? 1 : -1))
        .map(([date, d]) => summary(date, d));
      return json({ state: trashed ? 'trashed' : 'archived', entries });
    }],
    ['POST', /^\/api\/journal\/lock-all$/, () => {
      let locked = 0;
      mutate((s) => {
        for (const d of Object.values(s.journal)) if (!d.locked && !d.trashed) { d.locked = true; locked++; }
      });
      return json({ locked });
    }],
    ['GET', /^\/api\/journal\/?$/, ({ url }) => {
      const now = today();
      const from = url.searchParams.get('from') ?? `${now.slice(0, 7)}-01`;
      const to = url.searchParams.get('to') ?? now;
      const entries = Object.entries(getState().journal)
        .filter(([d]) => d >= from && d <= to)
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([d, day]) => summary(d, day));
      return json({ from, to, today: now, entries });
    }],
    ['GET', /^\/api\/journal\/([^/]+)$/, entryRoute((p, date) => reply(p, date))],
    ['PUT', /^\/api\/journal\/([^/]+)$/, entryRoute(async (p, date) => {
      if (compareDays(date, today()) > 0) return error('A journal day can’t be written before it begins.', 'future', 422);
      const day = getState().journal[date];
      if (day?.trashed) return error('This day is in the Trash. Restore it to write here.', 'trashed', 409);
      const patch = (await p.body()) as Write;
      if (day?.locked && patch.secure === false && !revealed(p.request)) return error('Unlock the vault to take the lock off an entry.', 'locked', 401);
      // A locked day's text is only replaced by a save that actually carries some.
      if (day?.locked && !patch.body) delete patch.body;
      write(date, patch);
      return reply(p, date);
    })],
    ['POST', /^\/api\/journal\/([^/]+)\/carry-over$/, entryRoute((p, date) => {
      const before = Object.keys(getState().journal).filter((d) => d < date && !getState().journal[d].locked && !getState().journal[d].trashed && openItems(getState().journal[d].body).length > 0).sort().pop();
      const items = before ? openItems(getState().journal[before].body) : [];
      const current = getState().journal[date]?.body ?? '';
      const fresh = items.filter((i) => !current.includes(i));
      if (fresh.length > 0) write(date, { body: current ? `${current.trimEnd()}\n\n${fresh.join('\n')}` : fresh.join('\n') });
      const res = reply(p, date);
      res.headers.set('X-Papyra-Carried', String(fresh.length));
      return res;
    })],
    ['POST', /^\/api\/journal\/([^/]+)\/append$/, entryRoute(async (p, date) => {
      const { text = '' } = (await p.body()) as { text?: string };
      const current = getState().journal[date]?.body ?? '';
      write(date, { body: current ? `${current.trimEnd()}\n\n${text}` : text });
      return reply(p, date);
    })],

    // The generic note routes, for a journal id: the Trash, the Trash's undo and the reveal.
    ['POST', /^\/api\/notes\/journal-(\d{4}-\d{2}-\d{2})\/trash$/, ({ match }) => {
      mutate((s) => { const d = s.journal[match[1]]; if (d) { d.trashed = true; d.trashedAt = new Date().toISOString(); } });
      return new Response(null, { status: 204 });
    }],
    ['POST', /^\/api\/notes\/journal-(\d{4}-\d{2}-\d{2})\/untrash$/, ({ match }) => {
      mutate((s) => { const d = s.journal[match[1]]; if (d) { d.trashed = false; d.trashedAt = null; } });
      return new Response(null, { status: 204 });
    }],
    ['GET', /^\/api\/notes\/journal-(\d{4}-\d{2}-\d{2})\/secure$/, ({ match }) => {
      const day = getState().journal[match[1]];
      return day ? json({ id: `journal-${match[1]}`, title: match[1], body: day.body, secure: true }) : new Response(null, { status: 404 });
    }],
  ];
}
