// A Papyra server, in a browser tab.
//
// papyra.web makes 97 `fetch()` calls spread across 40 files and has no central
// API client, so the demo intercepts at the only seam that covers all of them:
// `globalThis.fetch`. Not one call site is aware this exists. That is the whole
// design — the demo runs the real application, so it can never drift from it,
// and shipping the demo costs the product zero abstraction.
//
// Anything that is not /api/* falls through to the real fetch (JS chunks, fonts,
// images). Anything that genuinely needs a server — imports, exports, backups,
// passkeys — answers with a friendly refusal the app's existing toasts surface.

import type { Note } from '../types/note';
import { setSync } from '../lib/syncStatus';
import { getState, loadState, mutate, nextId, recountCategories } from './store';
import { CHAT_FALLBACK, CHAT_SCRIPT, DEMO_USER } from './seed';

type Handler = (ctx: {
  match: RegExpMatchArray;
  url: URL;
  request: Request;
  /** Parsed JSON request body, or `{}` when there is none. Cast at the call site. */
  body: () => Promise<unknown>;
}) => Response | Promise<Response>;

type Route = [method: string, pattern: RegExp, handler: Handler];

const json = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

const noContent = (): Response => new Response(null, { status: 204 });

/** For the parts that genuinely cannot exist without a server. */
const serverOnly = (what: string): Response =>
  json(
    {
      error: `${what} needs a real Papyra server. This demo runs entirely in your browser — install Papyra to use it for real.`,
    },
    501,
  );

const now = (): string => new Date().toISOString();

/** Strip markdown to something a snippet can show. */
const plain = (body: string): string =>
  body
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/^---[\s\S]*?---/m, ' ')
    .replace(/[#>*_`|-]/g, ' ')
    .replace(/\[\[([^\]]+)\]\]/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();

/** The highlighter's `<mark>` convention, which the UI parses rather than renders as HTML. */
function snippetFor(body: string, query: string, width = 140): string {
  const text = plain(body);
  const at = text.toLowerCase().indexOf(query.toLowerCase());
  if (at < 0) return text.slice(0, width);
  const start = Math.max(0, at - width / 3);
  const slice = text.slice(start, start + width);
  const prefix = start > 0 ? '…' : '';
  return (
    prefix +
    slice.replace(new RegExp(`(${query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'ig'), '<mark>$1</mark>')
  );
}

const live = (): Note[] => getState().notes.filter((n) => !n.trashed);

const findNote = (id: string): Note | undefined => getState().notes.find((n) => n.id === id);

/** Titles the wiki-link parser would resolve, mapped back to note ids. */
function linksOut(note: Note): string[] {
  return [...note.body.matchAll(/\[\[([^\]]+)\]\]/g)].map((m) => m[1].trim().toLowerCase());
}

// ---------------------------------------------------------------- AI streaming

/**
 * Stream a scripted answer as NDJSON, in the exact frame order ChatPanel parses:
 * `session`, then `citations`, then one `token` per fragment, then `done`.
 * Tokens are emitted on a timer so the answer types itself out the way a real
 * model's would — the citations land first, which is the honest order anyway.
 */
function chatStream(question: string, sessionId: number | null): Response {
  const script =
    CHAT_SCRIPT.find((s) => s.match.some((m) => question.toLowerCase().includes(m))) ?? null;
  const answer = script?.answer ?? CHAT_FALLBACK;
  const citations = script?.citations ?? [];

  const state = getState();
  let session = sessionId ? state.chatSessions.find((s) => s.id === sessionId) : undefined;
  if (!session) {
    const id = nextId();
    session = {
      id,
      title: question.length > 48 ? `${question.slice(0, 48)}…` : question,
      model: 'llama3.1:8b',
      provider: 'ollama',
      createdUtc: now(),
      updatedUtc: now(),
      messageCount: 0,
      messages: [],
    };
    mutate((s) => s.chatSessions.unshift(session!));
  }
  const landed = session;

  // Split on whitespace but keep it, so the reassembled answer is byte-identical.
  const fragments = answer.match(/\S+\s*/g) ?? [answer];

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const frame = (obj: unknown) => controller.enqueue(encoder.encode(`${JSON.stringify(obj)}\n`));
      const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

      frame({ type: 'session', sessionId: landed.id });
      await wait(180);
      frame({ type: 'citations', citations });
      await wait(220);

      for (const value of fragments) {
        frame({ type: 'token', value });
        // Fast enough to read along with, slow enough to look like thinking.
        await wait(14);
      }

      frame({ type: 'done' });
      controller.close();

      mutate((s) => {
        const rec = s.chatSessions.find((x) => x.id === landed.id);
        if (!rec) return;
        rec.messages.push(
          {
            id: nextId(),
            role: 'user',
            content: question,
            createdUtc: now(),
            citations: null,
          },
          {
            id: nextId(),
            role: 'assistant',
            content: answer,
            createdUtc: now(),
            citations,
          },
        );
        rec.messageCount = rec.messages.length;
        rec.updatedUtc = now();
      });
    },
  });

  return new Response(stream, {
    status: 200,
    headers: { 'Content-Type': 'application/x-ndjson' },
  });
}

// ------------------------------------------------------------------- the table
// Order matters: literal sub-paths (/api/notes/order) must be listed before the
// id pattern (/api/notes/:id) that would otherwise swallow them.

const routes: Route[] = [
  // ---------------------------------------------------------------- identity
  ['GET', /^\/api\/auth\/me$/, () => json(DEMO_USER)],
  ['GET', /^\/api\/auth\/providers$/, () => json({ password: true, oidc: null })],
  ['GET', /^\/api\/auth\/notifications$/, () => json({ mentions: true, shares: true })],
  ['PUT', /^\/api\/auth\/notifications$/, async ({ body }) => json(await body())],
  [
    'PUT',
    /^\/api\/auth\/profile$/,
    async ({ body }) => json({ ...DEMO_USER, ...((await body()) as Record<string, unknown>) }),
  ],
  ['POST', /^\/api\/auth\/password$/, () => serverOnly('Changing your password')],
  ['POST', /^\/api\/auth\/avatar$/, () => serverOnly('Uploading a picture')],
  // No stored avatar: 404 is what the real API answers, and Avatar falls back
  // to the initial rather than showing a broken image.
  ['GET', /^\/api\/auth\/avatar/, () => new Response(null, { status: 404 })],
  ['GET', /^\/api\/auth\/webauthn\/credentials$/, () => json([])],
  ['POST', /^\/api\/auth\/webauthn\//, () => serverOnly('Passkeys')],
  ['DELETE', /^\/api\/auth\/webauthn\//, () => serverOnly('Passkeys')],
  ['GET', /^\/api\/auth\/users$/, () => json([DEMO_USER])],
  ['POST', /^\/api\/auth\/users$/, () => serverOnly('Adding people')],
  ['DELETE', /^\/api\/auth\/users\//, () => serverOnly('Removing people')],
  ['GET', /^\/api\/auth\/oidc$/, () => json({ enabled: false, authority: '', clientId: '', displayName: '' })],
  ['PUT', /^\/api\/auth\/oidc$/, () => serverOnly('Single sign-on')],
  ['GET', /^\/api\/auth\/smtp$/, () => json({ enabled: false, host: '', port: 587, fromAddress: '', username: '', hasPassword: false, useStartTls: true })],
  ['PUT', /^\/api\/auth\/smtp$/, () => serverOnly('Email settings')],
  ['POST', /^\/api\/auth\/smtp\//, () => serverOnly('Sending email')],
  ['GET', /^\/api\/users\/search$/, () => json([{ username: 'dana', name: 'Dana' }])],

  // ------------------------------------------------------------------- notes
  [
    'GET',
    /^\/api\/notes$/,
    () => {
      const s = getState();
      // Secure bodies are withheld server-side in the real API; mirror that so
      // the Vault gate is demonstrating something real rather than a CSS blur.
      return json(s.notes.map((n) => (n.secure ? { ...n, body: '' } : n)));
    },
  ],
  ['GET', /^\/api\/notes\/order$/, () => json(getState().order)],
  [
    'PUT',
    /^\/api\/notes\/order$/,
    async ({ body }) => {
      const { entries } = (await body()) as { entries: { id: string; key: number; setAt: number }[] };
      return json(
        mutate((s) => {
          s.order = {};
          for (const e of entries) s.order[e.id] = { key: e.key, setAt: e.setAt };
          return s.order;
        }),
      );
    },
  ],
  [
    'GET',
    /^\/api\/notes\/activity$/,
    () => {
      // year → month → day → count, as the heatmap expects.
      const tree: Record<string, Record<string, Record<string, number>>> = {};
      for (const n of getState().notes) {
        const d = new Date(n.updated);
        if (Number.isNaN(d.getTime())) continue;
        const y = String(d.getFullYear());
        const m = String(d.getMonth() + 1).padStart(2, '0');
        const day = String(d.getDate()).padStart(2, '0');
        tree[y] ??= {};
        tree[y][m] ??= {};
        tree[y][m][day] = (tree[y][m][day] ?? 0) + 1;
      }
      return json(tree);
    },
  ],
  [
    'GET',
    /^\/api\/notes\/([^/]+)\/backlinks$/,
    ({ match }) => {
      const id = decodeURIComponent(match[1]);
      const target = findNote(id);
      if (!target) return json([]);
      const title = target.title.toLowerCase();
      return json(
        live()
          .filter((n) => n.id !== id && linksOut(n).some((l) => l === id.toLowerCase() || l === title))
          .map((n) => ({
            noteId: n.id,
            title: n.title,
            snippet: snippetFor(n.body, target.title),
            color: n.color,
          })),
      );
    },
  ],
  [
    'GET',
    /^\/api\/notes\/([^/]+)\/snapshots$/,
    ({ match }) => json((getState().snapshots[decodeURIComponent(match[1])] ?? []).map(({ id, timestamp }) => ({ id, timestamp }))),
  ],
  [
    'GET',
    /^\/api\/notes\/([^/]+)\/snapshots\/([^/]+)$/,
    ({ match }) => {
      const snaps = getState().snapshots[decodeURIComponent(match[1])] ?? [];
      const snap = snaps.find((s) => s.id === decodeURIComponent(match[2]));
      return snap ? json({ id: snap.id, timestamp: snap.timestamp, body: snap.body }) : json({ error: 'not found' }, 404);
    },
  ],
  [
    'POST',
    /^\/api\/notes\/([^/]+)\/restore\/([^/]+)$/,
    ({ match }) => {
      const id = decodeURIComponent(match[1]);
      const snapId = decodeURIComponent(match[2]);
      return mutate((s) => {
        const note = s.notes.find((n) => n.id === id);
        const snap = (s.snapshots[id] ?? []).find((x) => x.id === snapId);
        if (!note || !snap) return json({ error: 'not found' }, 404);
        // A restore is itself snapshotted, so it can be undone — same as the API.
        s.snapshots[id] = [{ id: `snap-${nextId()}`, timestamp: now(), body: note.body }, ...(s.snapshots[id] ?? [])];
        note.body = snap.body;
        note.updated = now();
        return json(note);
      });
    },
  ],
  [
    'GET',
    /^\/api\/notes\/([^/]+)\/blocks\/([^/]+)$/,
    ({ match }) => {
      const note = findNote(decodeURIComponent(match[1]));
      if (!note) return json({ error: 'not found' }, 404);
      const first = note.body.split('\n').find((l) => l.trim().length > 0) ?? '';
      return json({ id: decodeURIComponent(match[2]), text: first.trim() });
    },
  ],
  ['GET', /^\/api\/notes\/([^/]+)\/blocks$/, ({ match }) => {
    const note = findNote(decodeURIComponent(match[1]));
    if (!note) return json([]);
    return json(
      note.body
        .split('\n')
        .filter((l) => l.trim())
        .map((text, i) => ({ id: `b${i}`, text: text.trim() })),
    );
  }],
  // Unlocking a vault note needs a passkey the browser demo cannot verify, so
  // the gate opens here and hands back the body it was withholding.
  [
    'GET',
    /^\/api\/notes\/([^/]+)\/secure$/,
    ({ match }) => {
      const note = findNote(decodeURIComponent(match[1]));
      return note
        ? json({
            ...note,
            body:
              note.body ||
              'Passport and travel insurance numbers would live here.\n\nOn a real Papyra server this note stays sealed until a passkey — your fingerprint or face — unlocks it, and the server refuses to send the body until it has. The blur is not the lock; the server is.',
          })
        : json({ error: 'not found' }, 404);
    },
  ],
  ['GET', /^\/api\/notes\/([^/]+)\/shares$/, () => json([])],
  ['POST', /^\/api\/notes\/([^/]+)\/shares$/, () => serverOnly('Sharing a note')],
  [
    'POST',
    /^\/api\/notes\/([^/]+)\/trash$/,
    ({ match }) =>
      mutate((s) => {
        const note = s.notes.find((n) => n.id === decodeURIComponent(match[1]));
        if (!note) return json({ error: 'not found' }, 404);
        note.trashed = true;
        note.trashedAt = now();
        recountCategories(s);
        return json(note);
      }),
  ],
  [
    'POST',
    /^\/api\/notes\/([^/]+)\/untrash$/,
    ({ match }) =>
      mutate((s) => {
        const note = s.notes.find((n) => n.id === decodeURIComponent(match[1]));
        if (!note) return json({ error: 'not found' }, 404);
        note.trashed = false;
        note.trashedAt = null;
        recountCategories(s);
        return json(note);
      }),
  ],
  [
    // Upsert. The real API has no POST for notes — a new note is a PUT to an id
    // the client picked — so create and update are the same branch here too.
    'PUT',
    /^\/api\/notes\/([^/]+)$/,
    async ({ match, body }) => {
      const id = decodeURIComponent(match[1]);
      const payload = (await body()) as Partial<Note>;
      return mutate((s) => {
        const existing = s.notes.find((n) => n.id === id);
        if (existing) {
          // Snapshot the previous revision before overwriting, so File Recovery
          // and the Time machine have something real to scrub through.
          if (typeof payload.body === 'string' && payload.body !== existing.body) {
            s.snapshots[id] = [
              { id: `snap-${nextId()}`, timestamp: existing.updated, body: existing.body },
              ...(s.snapshots[id] ?? []),
            ].slice(0, 20);
          }
          Object.assign(existing, payload, { id, updated: now() });
          recountCategories(s);
          return json(existing);
        }
        const created: Note = {
          id,
          title: '',
          tags: [],
          color: null,
          pinned: false,
          archived: false,
          kind: 'note',
          trashed: false,
          trashedAt: null,
          secure: false,
          body: '',
          ...payload,
          updated: now(),
        };
        s.notes.unshift(created);
        recountCategories(s);
        return json(created);
      });
    },
  ],
  [
    'DELETE',
    /^\/api\/notes\/([^/]+)$/,
    ({ match }) =>
      mutate((s) => {
        const id = decodeURIComponent(match[1]);
        s.notes = s.notes.filter((n) => n.id !== id);
        delete s.snapshots[id];
        recountCategories(s);
        return noContent();
      }),
  ],

  // -------------------------------------------------------------- taxonomy
  ['GET', /^\/api\/categories$/, () => json(getState().categories)],
  [
    'POST',
    /^\/api\/categories$/,
    async ({ body }) => {
      const input = (await body()) as { name: string; color?: string | null };
      return mutate((s) => {
        const existing = s.categories.find((c) => c.name === input.name);
        if (existing) {
          existing.color = input.color ?? existing.color;
          return json(existing);
        }
        const created = { name: input.name, color: input.color ?? null, count: 0 };
        s.categories.push(created);
        recountCategories(s);
        return json(created);
      });
    },
  ],
  [
    'DELETE',
    /^\/api\/categories\/([^/]+)$/,
    ({ match }) =>
      mutate((s) => {
        const name = decodeURIComponent(match[1]);
        s.categories = s.categories.filter((c) => c.name !== name);
        for (const n of s.notes) n.tags = n.tags.filter((t) => t !== name);
        return noContent();
      }),
  ],
  ['GET', /^\/api\/collections$/, () => json(getState().collections)],
  [
    'POST',
    /^\/api\/collections$/,
    async ({ body }) => {
      const input = (await body()) as { name: string; rulesJson: string };
      return mutate((s) => {
        const created = { id: nextId(), name: input.name, rulesJson: input.rulesJson, createdUtc: now() };
        s.collections.push(created);
        return json(created);
      });
    },
  ],
  [
    'DELETE',
    /^\/api\/collections\/(\d+)$/,
    ({ match }) =>
      mutate((s) => {
        s.collections = s.collections.filter((c) => c.id !== Number(match[1]));
        return noContent();
      }),
  ],
  [
    'GET',
    /^\/api\/collections\/(\d+)\/notes$/,
    ({ match }) => {
      const col = getState().collections.find((c) => c.id === Number(match[1]));
      if (!col) return json([]);
      let rules: { match: 'all' | 'any'; conditions: { field: string; value: string }[] };
      try {
        rules = JSON.parse(col.rulesJson);
      } catch {
        return json([]);
      }
      const test = (n: Note, c: { field: string; value: string }): boolean => {
        switch (c.field) {
          case 'tag':
            return n.tags.includes(c.value);
          case 'color':
            return n.color === c.value;
          case 'pinned':
            return n.pinned === (c.value === 'true');
          case 'kind':
            return n.kind === c.value;
          case 'text':
            return `${n.title}\n${n.body}`.toLowerCase().includes(c.value.toLowerCase());
          default:
            return false;
        }
      };
      const matches = live().filter((n) =>
        rules.match === 'all'
          ? rules.conditions.every((c) => test(n, c))
          : rules.conditions.some((c) => test(n, c)),
      );
      return json(matches);
    },
  ],

  // -------------------------------------------------------------- settings
  ['GET', /^\/api\/settings$/, () => json(getState().settings)],
  [
    'PUT',
    /^\/api\/settings$/,
    async ({ body }) => {
      const patch = (await body()) as Partial<{ trashRetentionDays: number }>;
      return json(
        mutate((s) => {
          s.settings = { ...s.settings, ...patch };
          return s.settings;
        }),
      );
    },
  ],

  // ---------------------------------------------------------------- search
  [
    'GET',
    /^\/api\/search(\/semantic)?$/,
    ({ url }) => {
      const q = (url.searchParams.get('q') ?? '').trim();
      if (!q) return json([]);
      const needle = q.toLowerCase();
      const scored = live()
        .map((n) => {
          const title = n.title.toLowerCase();
          const body = n.secure ? '' : n.body.toLowerCase();
          let score = 0;
          if (title === needle) score += 100;
          else if (title.includes(needle)) score += 50;
          if (body.includes(needle)) score += 20;
          for (const word of needle.split(/\s+/)) {
            if (title.includes(word)) score += 6;
            if (body.includes(word)) score += 2;
          }
          return { n, score };
        })
        .filter((x) => x.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, 12);
      return json(
        scored.map(({ n }) => ({
          id: n.id,
          title: n.title,
          snippet: n.secure ? 'Locked — unlock to read this note.' : snippetFor(n.body, q),
          secure: n.secure,
        })),
      );
    },
  ],

  // -------------------------------------------------------------------- AI
  ['GET', /^\/api\/ai\/status$/, () =>
    json({
      chatProvider: 'ollama',
      embedProvider: 'ollama',
      chatModel: 'llama3.1:8b',
      embedModel: 'nomic-embed-text',
      ready: true,
      reason: null,
      canPull: false,
      installedModels: ['llama3.1:8b', 'nomic-embed-text'],
      semanticSearchReady: true,
    })],
  ['GET', /^\/api\/ai\/models$/, () =>
    // The three tiers the app really offers, with the real sizes from AiClient.
    json([
      { model: 'llama3.2:1b', tier: 'Small', size: '1.3 GB', memory: '2 GB', blurb: 'Runs on almost anything, including a Raspberry Pi.' },
      { model: 'llama3.1:8b', tier: 'Balanced', size: '4.7 GB', memory: '8 GB', blurb: 'The sensible default for a normal computer.' },
      { model: 'mistral-nemo:12b', tier: 'Best', size: '7.1 GB', memory: '12 GB', blurb: 'The best answers, if your machine can hold it.' },
    ])],
  ['GET', /^\/api\/ai\/config$/, () =>
    json({
      chatProvider: 'ollama',
      embedProvider: 'ollama',
      ollamaBaseUrl: 'http://ollama:11434',
      ollamaChatModel: 'llama3.1:8b',
      ollamaEmbedModel: 'nomic-embed-text',
      openAiBaseUrl: 'https://api.openai.com/v1',
      openAiChatModel: 'gpt-4o-mini',
      openAiEmbedModel: 'text-embedding-3-small',
      anthropicChatModel: 'claude-sonnet-4-5',
      hasOpenAiKey: false,
      hasAnthropicKey: false,
    })],
  ['PUT', /^\/api\/ai\/config$/, () => serverOnly('Changing the AI provider')],
  ['POST', /^\/api\/ai\/pull$/, () => serverOnly('Downloading a model')],
  [
    'GET',
    /^\/api\/ai\/sessions$/,
    () =>
      // Listed explicitly rather than destructuring `messages` away: the summary
      // endpoint returns ChatSessionSummary, and naming the fields keeps that
      // contract visible (and satisfies no-unused-vars, which does not allow
      // dropping a rest sibling here).
      json(
        getState().chatSessions.map((s) => ({
          id: s.id,
          title: s.title,
          model: s.model,
          provider: s.provider,
          createdUtc: s.createdUtc,
          updatedUtc: s.updatedUtc,
          messageCount: s.messageCount,
        })),
      ),
  ],
  [
    'GET',
    /^\/api\/ai\/sessions\/(\d+)$/,
    ({ match }) => {
      const rec = getState().chatSessions.find((s) => s.id === Number(match[1]));
      return rec ? json(rec) : json({ error: 'not found' }, 404);
    },
  ],
  [
    'PATCH',
    /^\/api\/ai\/sessions\/(\d+)$/,
    async ({ match, body }) => {
      const { title } = (await body()) as { title: string };
      return mutate((s) => {
        const rec = s.chatSessions.find((x) => x.id === Number(match[1]));
        if (!rec) return json({ error: 'not found' }, 404);
        rec.title = title;
        return json(rec);
      });
    },
  ],
  [
    'DELETE',
    /^\/api\/ai\/sessions\/(\d+)$/,
    ({ match }) =>
      mutate((s) => {
        s.chatSessions = s.chatSessions.filter((x) => x.id !== Number(match[1]));
        return noContent();
      }),
  ],
  [
    'POST',
    /^\/api\/ai\/chat$/,
    async ({ body }) => {
      const { question, sessionId } = (await body()) as { question: string; sessionId: number | null };
      return chatStream(question, sessionId);
    },
  ],

  // ----------------------------------------------------------------- inbox
  ['GET', /^\/api\/inbox$/, () => json(getState().inbox)],
  ['POST', /^\/api\/inbox\/read$/, () =>
    mutate((s) => {
      for (const e of s.inbox) e.readUtc ??= now();
      return noContent();
    })],
  [
    'DELETE',
    /^\/api\/inbox\/(\d+)$/,
    ({ match }) =>
      mutate((s) => {
        s.inbox = s.inbox.filter((e) => e.id !== Number(match[1]));
        return noContent();
      }),
  ],

  // ------------------------------------------------------- the quiet corners
  ['GET', /^\/api\/shares\/summary$/, () => json([])],
  ['GET', /^\/api\/shares\/incoming$/, () => json([])],
  ['DELETE', /^\/api\/shares\//, () => serverOnly('Revoking a share')],
  ['GET', /^\/api\/conflicts$/, () => json([])],
  ['GET', /^\/api\/keys$/, () => json([])],
  ['POST', /^\/api\/keys$/, () => serverOnly('Creating an API key')],
  ['DELETE', /^\/api\/keys\//, () => serverOnly('Deleting an API key')],
  ['GET', /^\/api\/webhooks$/, () => json([])],
  ['POST', /^\/api\/webhooks$/, () => serverOnly('Webhooks')],
  ['DELETE', /^\/api\/webhooks\//, () => serverOnly('Webhooks')],
  ['GET', /^\/api\/git$/, () => json({ enabled: false, remoteUrl: '', branch: 'main', lastSyncUtc: null, lastError: null })],
  ['PUT', /^\/api\/git$/, () => serverOnly('Git backup')],
  ['POST', /^\/api\/git\/sync$/, () => serverOnly('Git backup')],
  [
    'GET',
    /^\/api\/jobs$/,
    () =>
      // The four jobs the server really registers, so Settings → Jobs is honest.
      json([
        { id: 'trash-purge', name: 'Empty the Trash', description: 'Permanently removes notes that have been in the Trash longer than your retention setting.', kind: 'periodic', intervalSeconds: 3600, running: false, canTrigger: true, lastRun: null },
        { id: 'orphan-prune', name: 'Move unused pictures to Trash', description: 'Finds uploaded images no note refers to any more.', kind: 'periodic', intervalSeconds: 86400, running: false, canTrigger: true, lastRun: null },
        { id: 'share-cleanup', name: 'Tidy up finished share links', description: 'Removes links that have expired or run out of views.', kind: 'periodic', intervalSeconds: 3600, running: false, canTrigger: true, lastRun: null },
        { id: 'grant-cleanup', name: 'Tidy up mentions of deleted notes', description: 'Clears inbox entries whose source note no longer exists.', kind: 'periodic', intervalSeconds: 86400, running: false, canTrigger: true, lastRun: null },
      ]),
  ],
  ['POST', /^\/api\/jobs\//, () => serverOnly('Running a background job')],

  // --------------------------------------------- genuinely needs a real server
  ['POST', /^\/api\/import\//, () => serverOnly('Importing notes')],
  ['GET', /^\/api\/export$/, () => serverOnly('Exporting your vault')],
  ['POST', /^\/api\/backups\//, () => serverOnly('Backups')],
  ['POST', /^\/api\/system\//, () => serverOnly('Rebuilding the index')],
  ['POST', /^\/api\/media\/upload$/, () => serverOnly('Uploading files')],
];

// ------------------------------------------------------------------ install

let installed = false;

export function installDemoBackend(): void {
  if (installed) return;
  installed = true;

  loadState();
  // Nothing will ever tell the app it is online — useSignalR is stubbed out in
  // demo mode — and without this every save would divert into the offline
  // outbox instead of reaching the routes above.
  setSync({ online: true });

  const realFetch = globalThis.fetch.bind(globalThis);

  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const url = new URL(request.url, window.location.origin);

    // Same-origin /api only. Everything else — chunks, fonts, images — is a real
    // request to a real file.
    if (url.origin !== window.location.origin || !url.pathname.startsWith('/api/')) {
      return realFetch(input as RequestInfo, init);
    }

    const method = request.method.toUpperCase();
    for (const [routeMethod, pattern, handler] of routes) {
      if (routeMethod !== method) continue;
      const match = url.pathname.match(pattern);
      if (!match) continue;
      // A little latency: instant responses make the UI look fake, and they also
      // hide genuine loading states that ought to be visible in a demo.
      await new Promise((r) => setTimeout(r, 60 + Math.random() * 90));
      try {
        return await handler({
          match,
          url,
          request,
          body: async () => {
            const text = await request.clone().text();
            return text ? JSON.parse(text) : {};
          },
        });
      } catch (err) {
        console.error('[demo] handler failed', url.pathname, err);
        return json({ error: 'The demo hit an unexpected problem. Try Start over in the banner.' }, 500);
      }
    }

    return json({ error: `Not available in the browser demo: ${method} ${url.pathname}` }, 501);
  };
}
