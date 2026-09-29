// End-to-end smoke of the *built bundle*: real WebSocket server, two scripted
// collaborators, in-memory API. Proves every bundled dependency (Hocuspocus,
// Yjs, Lexical, luthor) loaded and that concurrent edits converge and save.
import { randomBytes } from 'node:crypto'
import type { Logger } from './rooms'
import { createMemoryNotesApi } from './memoryApi'
import { CLOSE_ACCESS_REVOKED, createCollabServer } from './server'
import { createTestClient, waitFor } from './testClient'
import { mintTicket } from './ticket'

export async function runSelftest(log: Logger): Promise<boolean> {
  const secret = randomBytes(32).toString('hex')
  const room = '7:selftest'
  const api = createMemoryNotesApi({ [room]: 'Hello world\n\nSecond block [[Plan]]' })
  const collab = createCollabServer({ secret, api, log: { ...log, info: () => {} }, debounce: 50, maxDebounce: 200 })
  const clients: Array<ReturnType<typeof createTestClient>> = []

  try {
    const port = await collab.listen()
    const url = `ws://127.0.0.1:${port}`
    const exp = Math.floor(Date.now() / 1000) + 60
    const ticket = (uid: number) =>
      mintTicket(secret, { v: 1, uid, name: `user${uid}`, owner: 7, note: 'selftest', access: 'edit', iat: Date.now(), exp })

    const alice = createTestClient(url, room, ticket(1))
    const bob = createTestClient(url, room, ticket(2))
    clients.push(alice, bob)
    await Promise.all([alice.synced, bob.synced])
    await waitFor(() => alice.markdown().startsWith('Hello world') && bob.markdown().startsWith('Hello world'), 5000, 'initial sync')

    alice.type(0, 5, ' brave')
    bob.type(0, 11, '!')
    const expected = 'Hello brave world!\n\nSecond block [[Plan]]'
    await waitFor(() => alice.markdown() === expected && bob.markdown() === expected, 5000, 'convergence')
    await waitFor(() => api.notes.get(room)!.body === expected, 5000, 'save')

    const health = await fetch(`http://127.0.0.1:${port}/healthz`).then((r) => r.json() as Promise<{ status: string }>)
    if (health.status !== 'ok') throw new Error('healthz not ok')

    const kick = await fetch(`http://127.0.0.1:${port}/rooms/${encodeURIComponent(room)}/kick?uid=2`, {
      method: 'POST',
      headers: { 'X-Collab-Secret': secret },
    })
    if (!kick.ok) throw new Error(`kick failed: HTTP ${kick.status}`)
    const reason = await bob.closed
    if (reason !== CLOSE_ACCESS_REVOKED) throw new Error(`kicked client closed with "${reason}", expected "${CLOSE_ACCESS_REVOKED}"`)

    log.info('selftest passed')
    return true
  } catch (error) {
    log.error(`selftest failed: ${(error as Error).message}`)
    return false
  } finally {
    for (const client of clients) client.destroy()
    await collab.stop()
  }
}
