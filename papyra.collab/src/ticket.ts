// Room tickets: short-lived, HMAC-signed grants the API mints after it has
// checked the caller may open the note (owner, or a live user share). The
// collab server never talks to the database — it trusts only what the API
// signed with the per-boot secret it was spawned with.
//
// Wire format (mirrors Papyra.Api Collab/CollabTicket.cs):
//   base64url(utf8 JSON payload) + "." + base64url(HMAC-SHA256(secret, payloadPart))
import { createHmac, timingSafeEqual } from 'node:crypto'

export type CollabAccess = 'edit' | 'view'

export interface CollabTicket {
  /** Ticket format version. */
  v: 1
  /** Signed-in user the ticket was issued to. */
  uid: number
  /** Display name shown on this user's caret. */
  name: string
  /** Vault that owns the note (note ids are only unique per vault). */
  owner: number
  note: string
  access: CollabAccess
  /** Issued-at, unix milliseconds — lets a kick refuse tickets minted before it. */
  iat: number
  /** Expiry, unix seconds. Tickets only gate the connect; they are short. */
  exp: number
}

/** The Hocuspocus document name for a note: `{ownerId}:{noteId}`. */
export function roomName(owner: number, note: string): string {
  return `${owner}:${note}`
}

/** Split a room name back into its owner and note id (ids may contain ':'). */
export function parseRoomName(name: string): { owner: number; note: string } | null {
  const sep = name.indexOf(':')
  if (sep <= 0) return null
  const owner = Number(name.slice(0, sep))
  const note = name.slice(sep + 1)
  if (!Number.isSafeInteger(owner) || owner <= 0 || note.length === 0) return null
  return { owner, note }
}

function sign(secret: string, payloadPart: string): Buffer {
  return createHmac('sha256', secret).update(payloadPart, 'ascii').digest()
}

/** Mint a ticket — used by tests and the selftest; production tickets come from the API. */
export function mintTicket(secret: string, ticket: CollabTicket): string {
  const payloadPart = Buffer.from(JSON.stringify(ticket), 'utf8').toString('base64url')
  return `${payloadPart}.${sign(secret, payloadPart).toString('base64url')}`
}

export type TicketError = 'malformed' | 'bad-signature' | 'expired' | 'wrong-room'

/**
 * Verify a ticket for `documentName`. Returns the ticket, or the reason it was
 * refused. `now` is unix seconds (injectable for tests).
 */
export function verifyTicket(
  secret: string,
  token: string,
  documentName: string,
  now: number = Math.floor(Date.now() / 1000),
): CollabTicket | TicketError {
  const dot = token.indexOf('.')
  if (dot <= 0 || dot === token.length - 1) return 'malformed'
  const payloadPart = token.slice(0, dot)
  let given: Buffer
  try {
    given = Buffer.from(token.slice(dot + 1), 'base64url')
  } catch {
    return 'malformed'
  }
  const expected = sign(secret, payloadPart)
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return 'bad-signature'
  }

  let ticket: CollabTicket
  try {
    ticket = JSON.parse(Buffer.from(payloadPart, 'base64url').toString('utf8'))
  } catch {
    return 'malformed'
  }
  if (
    ticket?.v !== 1 ||
    !Number.isSafeInteger(ticket.uid) ||
    !Number.isSafeInteger(ticket.owner) ||
    typeof ticket.note !== 'string' ||
    typeof ticket.name !== 'string' ||
    (ticket.access !== 'edit' && ticket.access !== 'view') ||
    typeof ticket.iat !== 'number' ||
    typeof ticket.exp !== 'number'
  ) {
    return 'malformed'
  }
  if (ticket.exp <= now) return 'expired'
  if (roomName(ticket.owner, ticket.note) !== documentName) return 'wrong-room'
  return ticket
}
