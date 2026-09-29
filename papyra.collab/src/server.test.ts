import { afterEach, describe, expect, it } from 'vitest'
import { randomBytes } from 'node:crypto'
import { createMemoryNotesApi, type MemoryNotesApi } from './memoryApi'
import { CLOSE_ACCESS_REVOKED, CLOSE_NOTE_GONE, createCollabServer } from './server'
import { createTestClient, waitFor, type TestClient } from './testClient'
import { mintTicket, type CollabAccess } from './ticket'

const ROOM = '7:shared'
const quiet = { info: () => {}, warn: () => {}, error: () => {} }

let cleanup: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const fn of cleanup.reverse()) await fn()
  cleanup = []
})

async function start(body = 'Hello world\n\nSecond') {
  const secret = randomBytes(32).toString('hex')
  const api: MemoryNotesApi = createMemoryNotesApi({ [ROOM]: body })
  const collab = createCollabServer({ secret, api, log: quiet, debounce: 30, maxDebounce: 100, maxRoomSize: 3 })
  const port = await collab.listen()
  cleanup.push(() => collab.stop())
  const url = `ws://127.0.0.1:${port}`
  const http = `http://127.0.0.1:${port}`

  const ticket = (uid: number, access: CollabAccess = 'edit', room = ROOM, iat = Date.now()) => {
    const [owner, note] = [Number(room.split(':')[0]), room.slice(room.indexOf(':') + 1)]
    return mintTicket(secret, { v: 1, uid, name: `u${uid}`, owner, note, access, iat, exp: Math.floor(Date.now() / 1000) + 60 })
  }
  const connect = (token: string, room = ROOM): TestClient => {
    const client = createTestClient(url, room, token)
    cleanup.push(() => client.destroy())
    return client
  }
  const internal = (path: string, init: RequestInit = {}) =>
    fetch(`${http}${path}`, { method: 'POST', ...init, headers: { 'X-Collab-Secret': secret, ...(init.headers ?? {}) } })
  return { api, secret, url, http, ticket, connect, internal }
}

describe('collab server', () => {
  it('lets concurrent editors converge and persists the merged note', async () => {
    const { api, ticket, connect } = await start()
    const a = connect(ticket(1))
    const b = connect(ticket(2))
    await Promise.all([a.synced, b.synced])
    await waitFor(() => a.markdown().startsWith('Hello') && b.markdown().startsWith('Hello'))

    a.type(0, 5, ' brave')
    b.type(1, 6, ' block')
    const expected = 'Hello brave world\n\nSecond block'
    await waitFor(() => a.markdown() === expected && b.markdown() === expected, 5000, 'convergence')
    await waitFor(() => api.notes.get(ROOM)!.body === expected, 5000, 'save')
    expect(new Set(api.saves.flatMap((save) => save.contributors))).toEqual(new Set([1, 2]))
  })

  it('refuses a ticket for another vault\'s note with the same id', async () => {
    const { ticket, connect } = await start()
    const client = connect(ticket(1, 'edit', '8:shared'))
    expect(await client.closed).toMatch(/^auth-failed/)
  })

  it('keeps view-only users from changing the note', async () => {
    const { api, ticket, connect } = await start('Read me')
    const viewer = connect(ticket(5, 'view'))
    const editor = connect(ticket(1))
    await Promise.all([viewer.synced, editor.synced])
    await waitFor(() => viewer.markdown() === 'Read me')

    viewer.type(0, 0, 'HACK ')
    editor.type(0, 7, '!')
    await waitFor(() => api.notes.get(ROOM)!.body === 'Read me!', 5000, 'editor save')
    // The viewer still receives edits (its own rejected change stays local).
    await waitFor(() => viewer.markdown().endsWith('Read me!'), 5000, 'viewer receives edits')
    // Give a rejected viewer update every chance to land, then confirm it did not.
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(api.notes.get(ROOM)!.body).toBe('Read me!')
  })

  it('kicks a revoked user and refuses their old ticket, but not a fresh one', async () => {
    const { ticket, connect, internal } = await start()
    const staleTicket = ticket(2)
    const bob = connect(staleTicket)
    await bob.synced

    const res = await internal(`/rooms/${encodeURIComponent(ROOM)}/kick?uid=2`)
    expect(await res.json()).toEqual({ closed: 1 })
    expect(await bob.closed).toBe(CLOSE_ACCESS_REVOKED)

    const again = connect(staleTicket)
    expect(await again.closed).toMatch(/^auth-failed/)

    await new Promise((resolve) => setTimeout(resolve, 5))
    const regranted = connect(ticket(2))
    await regranted.synced
  })

  it('pushes an external file edit to everyone in the room', async () => {
    const { api, ticket, connect, internal } = await start('One')
    const client = connect(ticket(1))
    await client.synced
    await waitFor(() => client.markdown() === 'One')

    const current = api.writeExternally(ROOM, 'One\n\nTwo from git')
    const res = await internal(`/rooms/${encodeURIComponent(ROOM)}/external`, {
      body: JSON.stringify({ body: current.body, hash: current.hash }),
      headers: { 'Content-Type': 'application/json' },
    })
    expect(await res.json()).toEqual({ applied: true })
    await waitFor(() => client.markdown() === 'One\n\nTwo from git', 5000, 'external adopt')
  })

  it('closes everyone out when the note is trashed', async () => {
    const { ticket, connect, internal } = await start()
    const client = connect(ticket(1))
    await client.synced
    await internal(`/rooms/${encodeURIComponent(ROOM)}/close?mode=discard`)
    expect(await client.closed).toBe(CLOSE_NOTE_GONE)
  })

  it('caps the number of people in one room', async () => {
    const { ticket, connect } = await start()
    const clients = [connect(ticket(1)), connect(ticket(2)), connect(ticket(3))]
    await Promise.all(clients.map((client) => client.synced))
    const fourth = connect(ticket(4))
    expect(await fourth.closed).toMatch(/^auth-failed/)
  })

  it('guards internal routes with the shared secret', async () => {
    const { http } = await start()
    const res = await fetch(`${http}/rooms/${encodeURIComponent(ROOM)}/kick?uid=1`, { method: 'POST' })
    expect(res.status).toBe(403)
    const health = await fetch(`${http}/healthz`)
    expect(health.status).toBe(200)
  })
})
