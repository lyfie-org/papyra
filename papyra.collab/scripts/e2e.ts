// End-to-end check of live collaboration through a REAL Papyra API: the API
// spawns the embedded engine, browsers-equivalent clients connect through the
// API's /collab WebSocket proxy with a session cookie + ticket, edit
// concurrently, and the merged note must land in the .md on disk (read back
// via the API). Then a share is revoked and that user must be kicked.
//
// Needs a FRESH instance (it runs first-admin setup):
//   PAPYRA_E2E_URL=http://127.0.0.1:8080 pnpm --filter papyra-collab e2e
// Used by CI (e2e-collab job) and the release smoke test against the image.
import { createHmac, randomBytes } from 'node:crypto'
import { createTestClient, waitFor, type TestClient } from '../src/testClient'

const BASE = (process.env.PAPYRA_E2E_URL ?? 'http://127.0.0.1:8080').replace(/\/$/, '')
const WS = `${BASE.replace(/^http/, 'ws')}/collab`
const PASSWORD = 'e2e-Password-1!'
const PIN = '480913'

// ── Tiny cookie-carrying HTTP client ──────────────────────────────────────────
class Session {
  private cookies = new Map<string, string>()

  cookieHeader(): string {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ')
  }

  async request(method: string, path: string, body?: unknown): Promise<Response> {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: {
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(this.cookies.size ? { Cookie: this.cookieHeader() } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'manual',
    })
    for (const line of res.headers.getSetCookie()) {
      const [pair] = line.split(';')
      const eq = pair!.indexOf('=')
      const value = pair!.slice(eq + 1)
      if (/expires=Thu, 01 Jan 1970/i.test(line) || value === '') this.cookies.delete(pair!.slice(0, eq))
      else this.cookies.set(pair!.slice(0, eq), value)
    }
    return res
  }

  async json<T>(method: string, path: string, body?: unknown, expect = [200, 204]): Promise<T> {
    const res = await this.request(method, path, body)
    const text = await res.text()
    if (!expect.includes(res.status)) throw new Error(`${method} ${path} → ${res.status}: ${text.slice(0, 300)}`)
    return (text ? JSON.parse(text) : undefined) as T
  }
}

// RFC 6238 TOTP (SHA1, 6 digits, 30s) — setup requires an authenticator.
function base32Decode(text: string): Buffer {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
  let bits = ''
  for (const ch of text.replace(/=+$/, '').toUpperCase()) bits += alphabet.indexOf(ch).toString(2).padStart(5, '0')
  const bytes: number[] = []
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2))
  return Buffer.from(bytes)
}
function base32Encode(bytes: Buffer): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
  let bits = ''
  for (const b of bytes) bits += b.toString(2).padStart(8, '0')
  let out = ''
  for (let i = 0; i < bits.length; i += 5) out += alphabet[parseInt(bits.slice(i, i + 5).padEnd(5, '0'), 2)]
  return out
}
function totp(secret: string): string {
  const counter = Buffer.alloc(8)
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 1000 / 30)))
  const hmac = createHmac('sha1', base32Decode(secret)).update(counter).digest()
  const offset = hmac[hmac.length - 1]! & 0xf
  return String((hmac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, '0')
}

// Node's WebSocket (undici) accepts headers; browsers send the cookie themselves.
function webSocketWithCookie(cookie: string) {
  return class extends WebSocket {
    constructor(url: string | URL, protocols?: string | string[]) {
      super(url, { protocols, headers: { Cookie: cookie } } as unknown as string[])
    }
  }
}

async function main(): Promise<void> {
  const step = (message: string) => console.log(`[e2e] ${message}`)
  // The engine starts right after Kestrel; give it a moment. (/health may
  // answer 428 until first-admin setup — the body still says how collab is.)
  const started = Date.now()
  for (;;) {
    const h = await new Session().json<{ collab?: string }>('GET', '/health', undefined, [200, 428])
    if (h?.collab === 'ok') break
    if (Date.now() - started > 60_000) throw new Error(`collab engine never became ok (last: ${h?.collab})`)
    await new Promise((r) => setTimeout(r, 500))
  }
  step('health collab=ok')

  const owner = new Session()
  const totpSecret = base32Encode(randomBytes(20))
  await owner.json('POST', '/api/auth/setup', {
    username: 'owner', name: 'Owner', email: 'owner@example.test', password: PASSWORD,
    pin: PIN, totpSecret, totpCode: totp(totpSecret),
  })
  step('owner set up')

  await owner.json('POST', '/api/auth/users', {
    username: 'bea', name: 'Bea', email: 'bea@example.test', password: PASSWORD, role: 'User',
  })
  const bea = new Session()
  await bea.json('POST', '/api/auth/login', { username: 'bea', password: PASSWORD })
  await bea.json('POST', '/api/auth/password', { current: PASSWORD, next: PASSWORD })
  step('bea provisioned')

  await owner.json('PUT', '/api/notes/e2e-live', {
    title: 'Live', tags: null, color: null, pinned: false, archived: false,
    body: 'Hello world\n\nSecond block', kind: null,
  })
  const share = await owner.json<{ id: number }>('POST', '/api/notes/e2e-live/shares', {
    kind: 'user', access: 'edit', granteeUsername: 'bea', expiresUtc: null, maxViews: null,
  })
  step(`shared (share ${share.id})`)

  const ownerTicket = await owner.json<{ ticket: string; room: string }>('POST', '/api/collab/ticket', { noteId: 'e2e-live' })
  const beaTicket = await bea.json<{ ticket: string; room: string }>('POST', '/api/collab/ticket', { shareId: share.id })
  if (ownerTicket.room !== beaTicket.room) throw new Error('owner and grantee got different rooms')

  const clients: TestClient[] = []
  try {
    const a = createTestClient(WS, ownerTicket.room, ownerTicket.ticket, webSocketWithCookie(owner.cookieHeader()))
    const b = createTestClient(WS, beaTicket.room, beaTicket.ticket, webSocketWithCookie(bea.cookieHeader()))
    clients.push(a, b)
    await Promise.all([a.synced, b.synced])
    await waitFor(() => a.markdown().startsWith('Hello world') && b.markdown().startsWith('Hello world'), 10_000, 'initial sync')
    step('both clients synced through /collab')

    a.type(0, 5, ' brave')
    b.type(1, 6, ' block')
    const expected = 'Hello brave world\n\nSecond block block'
    await waitFor(() => a.markdown() === expected && b.markdown() === expected, 10_000, 'convergence')
    step('concurrent edits converged')

    const started = Date.now()
    for (;;) {
      const notes = await owner.json<Array<{ id: string; body: string }>>('GET', '/api/notes')
      if (notes.find((n) => n.id === 'e2e-live')?.body === expected) break
      if (Date.now() - started > 20_000) throw new Error('merged body never reached the note on disk')
      await new Promise((r) => setTimeout(r, 250))
    }
    step('merged note saved to disk by the API')

    // A classic write while the room is live must be refused.
    const clobber = await owner.request('PUT', '/api/notes/e2e-live', {
      title: 'Live', tags: null, color: null, pinned: false, archived: false, body: 'stale tab', kind: null,
    })
    if (clobber.status !== 409) throw new Error(`classic write during live room returned ${clobber.status}, expected 409`)
    step('classic body write refused while live (409)')

    // Restoring an older version while the room is live replaces everyone's
    // text in place (never merged), and history credits who wrote the version
    // the restore replaced.
    const versions = await owner.json<Array<{ id: string }>>('GET', '/api/notes/e2e-live/snapshots')
    if (versions.length === 0) throw new Error('no earlier version to restore')
    const restoreRes = await owner.request('POST', `/api/notes/e2e-live/restore/${versions[0]!.id}`)
    if (restoreRes.status !== 200) throw new Error(`restore while live returned ${restoreRes.status}`)
    const undoId = restoreRes.headers.get('Papyra-Undo-Snapshot')
    const original = 'Hello world\n\nSecond block'
    await waitFor(() => a.markdown() === original && b.markdown() === original, 10_000, 'restore reaches the room')
    step('restore replaced the live room in place')
    if (!undoId) throw new Error('restore returned no undo snapshot')
    const afterRestore = await owner.json<Array<{ id: string; editors: string[] }>>('GET', '/api/notes/e2e-live/snapshots')
    const undo = afterRestore.find((v) => v.id === undoId)
    if (!undo || !undo.editors.includes('Owner') || !undo.editors.includes('Bea')) {
      throw new Error(`undo version should credit Owner and Bea, got ${JSON.stringify(undo)}`)
    }
    step('history credits the room editors (Owner, Bea)')

    await owner.json('DELETE', `/api/shares/${share.id}`)
    const reason = await Promise.race([b.closed, new Promise<string>((r) => setTimeout(() => r('timeout'), 10_000))])
    if (reason !== 'access-revoked') throw new Error(`revoked grantee closed with "${reason}"`)
    step('revoked grantee kicked (access-revoked)')

    console.log('[e2e] PASS')
  } finally {
    for (const client of clients) client.destroy()
  }
}

main().then(
  () => setTimeout(() => process.exit(0), 250),
  (error: Error) => {
    console.error(`[e2e] FAIL: ${error.message}`)
    setTimeout(() => process.exit(1), 250)
  },
)
