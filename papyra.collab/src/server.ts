// Hocuspocus wiring: auth by API-minted ticket, rooms backed by RoomRegistry,
// plus a tiny internal HTTP surface the API uses to steer rooms (kick a
// revoked user, close a trashed note, adopt an external file edit).
//
// Listens on loopback only. Browsers reach /collab through the API's proxy;
// internal routes additionally require the per-boot shared secret.
import type { IncomingMessage, ServerResponse } from 'node:http'
import { timingSafeEqual } from 'node:crypto'
import { Server, type Hocuspocus } from '@hocuspocus/server'
import type { NotesApi } from './api'
import { RoomRegistry, type Logger } from './rooms'
import { verifyTicket, type CollabTicket } from './ticket'

export interface CollabServerOptions {
  secret: string
  api: NotesApi
  log: Logger
  port?: number
  address?: string
  /** onStoreDocument debounce / max wait (ms). */
  debounce?: number
  maxDebounce?: number
  /** Most simultaneous connections per note. */
  maxRoomSize?: number
  /** Largest accepted WebSocket frame (bytes). */
  maxPayload?: number
}

/** Connection context set in onAuthenticate. */
export type CollabContext = Pick<CollabTicket, 'uid' | 'name' | 'access'>

/**
 * Close reasons the web client maps to UI states. Hocuspocus closes a document
 * connection with a CLOSE message whose *reason* reaches the provider (the
 * code is always reported as 1000), so the reason is the contract.
 */
export const CLOSE_ACCESS_REVOKED = 'access-revoked'
export const CLOSE_NOTE_GONE = 'note-gone'

function secretMatches(given: string | string[] | undefined, secret: string): boolean {
  if (typeof given !== 'string') return false
  const a = Buffer.from(given)
  const b = Buffer.from(secret)
  return a.length === b.length && timingSafeEqual(a, b)
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'Content-Type': 'application/json' })
  response.end(JSON.stringify(body))
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    size += (chunk as Buffer).length
    if (size > 16 * 1024 * 1024) throw new Error('body too large')
    chunks.push(chunk as Buffer)
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}
}

function closeWith(instance: Hocuspocus, documentName: string, reason: string, uid?: number) {
  const document = instance.documents.get(documentName)
  if (!document) return 0
  let closed = 0
  for (const connection of document.getConnections()) {
    const context = connection.context as CollabContext | undefined
    if (uid === undefined || context?.uid === uid) {
      connection.close({ code: 4000, reason })
      closed += 1
    }
  }
  return closed
}

export function createCollabServer(options: CollabServerOptions) {
  const { secret, log } = options
  const maxRoomSize = options.maxRoomSize ?? 20
  let instance: Hocuspocus | null = null
  // room|uid → kick time (ms). A kicked user's still-unexpired ticket must not
  // get them straight back in; a ticket minted after the kick (access
  // re-granted) is fine. Entries outlive any ticket, then are pruned.
  const kicked = new Map<string, number>()
  const KICK_MEMORY_MS = 10 * 60 * 1000

  const rooms = new RoomRegistry({
    api: options.api,
    log,
    closeRoom: (documentName) => {
      if (instance) closeWith(instance, documentName, CLOSE_NOTE_GONE)
    },
  })

  async function handleInternal(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', 'http://collab.local')

    if (url.pathname === '/healthz') {
      json(response, 200, {
        status: 'ok',
        rooms: instance?.getDocumentsCount() ?? 0,
        connections: instance?.getConnectionsCount() ?? 0,
        stats: rooms.stats,
      })
      return
    }

    if (!secretMatches(request.headers['x-collab-secret'], secret)) {
      json(response, 403, { error: 'forbidden' })
      return
    }

    // /rooms/{room}[/action] — the room name is URL-encoded (note ids can hold ':' '/').
    const match = /^\/rooms\/([^/]+)(?:\/(kick|close|external|flush|restore))?$/.exec(url.pathname)
    if (!match || !instance) {
      json(response, 404, { error: 'not-found' })
      return
    }
    const documentName = decodeURIComponent(match[1]!)
    const action = match[2]

    if (!action && request.method === 'GET') {
      const document = instance.documents.get(documentName)
      json(response, 200, { active: Boolean(document), connections: document?.getConnectionsCount() ?? 0 })
      return
    }
    if (request.method !== 'POST') {
      json(response, 405, { error: 'method-not-allowed' })
      return
    }
    if (action === 'kick') {
      const uid = Number(url.searchParams.get('uid'))
      if (!Number.isSafeInteger(uid)) {
        json(response, 400, { error: 'uid required' })
        return
      }
      const now = Date.now()
      for (const [key, at] of kicked) if (now - at > KICK_MEMORY_MS) kicked.delete(key)
      kicked.set(`${documentName}|${uid}`, now)
      const closed = closeWith(instance, documentName, CLOSE_ACCESS_REVOKED, uid)
      json(response, 200, { closed })
      return
    }
    if (action === 'close') {
      const mode = url.searchParams.get('mode') === 'discard' ? 'discard' : 'flush'
      await rooms.close(documentName, mode)
      json(response, 200, { closed: true })
      return
    }
    if (action === 'flush') {
      await rooms.store(documentName)
      json(response, 200, { flushed: true })
      return
    }
    if (action === 'external' || action === 'restore') {
      const body = (await readJson(request)) as { body?: unknown; hash?: unknown }
      if (typeof body.body !== 'string' || typeof body.hash !== 'string') {
        json(response, 400, { error: 'body and hash required' })
        return
      }
      const current = { body: body.body, hash: body.hash }
      const applied = action === 'restore'
        ? await rooms.restore(documentName, current)
        : await rooms.external(documentName, current)
      json(response, 200, { applied })
      return
    }
    json(response, 404, { error: 'not-found' })
  }

  const server = new Server<CollabContext>({
    name: 'papyra-collab',
    port: options.port ?? 0,
    address: options.address ?? '127.0.0.1',
    quiet: true,
    stopOnSignals: false,
    debounce: options.debounce ?? 2000,
    maxDebounce: options.maxDebounce ?? 10000,
    // Last client leaving stores immediately, then unloads.
    unloadImmediately: true,
    websocketOptions: { maxPayload: options.maxPayload ?? 8 * 1024 * 1024 },

    async onConfigure({ instance: configured }) {
      instance = configured
    },

    async onAuthenticate({ token, documentName, connectionConfig, instance: current }) {
      const ticket = verifyTicket(secret, token, documentName)
      if (typeof ticket === 'string') {
        log.warn(`[${documentName}] refused connection: ${ticket}`)
        throw new Error(ticket)
      }
      const kickedAt = kicked.get(`${documentName}|${ticket.uid}`)
      if (kickedAt !== undefined && ticket.iat <= kickedAt) {
        log.warn(`[${documentName}] refused connection: ticket predates revocation`)
        throw new Error(CLOSE_ACCESS_REVOKED)
      }
      const open = current.documents.get(documentName)
      if (open && open.getConnectionsCount() >= maxRoomSize) {
        throw new Error('room-full')
      }
      connectionConfig.readOnly = ticket.access !== 'edit'
      return { uid: ticket.uid, name: ticket.name, access: ticket.access } satisfies CollabContext
    },

    async onLoadDocument({ documentName, document }) {
      await rooms.load(documentName, document)
    },

    async onChange({ documentName, context }) {
      rooms.touch(documentName, context?.uid)
    },

    async onStoreDocument({ documentName }) {
      await rooms.store(documentName)
    },

    async afterUnloadDocument({ documentName }) {
      rooms.dispose(documentName)
    },

    async onRequest({ request, response }) {
      // Hocuspocus answers every plain HTTP request with its banner unless a
      // hook throws; handle ours and stop the chain.
      await handleInternal(request, response).catch((error: Error) => {
        log.error(`internal request failed: ${error.message}`)
        if (!response.headersSent) json(response, 500, { error: 'internal' })
      })
      throw null
    },
  })

  return {
    server,
    rooms,
    async listen(): Promise<number> {
      await server.listen()
      instance = server.hocuspocus
      return server.address.port
    },
    async stop(): Promise<void> {
      await server.destroy()
    },
  }
}
