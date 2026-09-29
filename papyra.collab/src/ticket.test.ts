import { describe, expect, it } from 'vitest'
import { mintTicket, parseRoomName, roomName, verifyTicket, type CollabTicket } from './ticket'

const SECRET = 'a'.repeat(64)
const NOW = 1_800_000_000
const base: CollabTicket = { v: 1, uid: 3, name: 'Ada', owner: 7, note: 'Inbox', access: 'edit', iat: NOW * 1000, exp: NOW + 60 }

describe('room names', () => {
  it('keys rooms by owner and note (ids are per vault)', () => {
    expect(roomName(7, 'Inbox')).toBe('7:Inbox')
    expect(roomName(8, 'Inbox')).not.toBe(roomName(7, 'Inbox'))
  })

  it('parses note ids that themselves contain colons', () => {
    expect(parseRoomName('7:a:b')).toEqual({ owner: 7, note: 'a:b' })
    expect(parseRoomName('x:note')).toBeNull()
    expect(parseRoomName('7:')).toBeNull()
    expect(parseRoomName('0:note')).toBeNull()
  })
})

describe('tickets', () => {
  it('accepts a valid ticket for its own room', () => {
    expect(verifyTicket(SECRET, mintTicket(SECRET, base), '7:Inbox', NOW)).toEqual(base)
  })

  it('refuses another room, even with the same note id in another vault', () => {
    expect(verifyTicket(SECRET, mintTicket(SECRET, base), '8:Inbox', NOW)).toBe('wrong-room')
  })

  it('refuses expired tickets', () => {
    expect(verifyTicket(SECRET, mintTicket(SECRET, base), '7:Inbox', NOW + 60)).toBe('expired')
  })

  it('refuses tickets signed with another secret', () => {
    expect(verifyTicket(SECRET, mintTicket('b'.repeat(64), base), '7:Inbox', NOW)).toBe('bad-signature')
  })

  it('refuses a tampered payload (e.g. view upgraded to edit)', () => {
    const token = mintTicket(SECRET, { ...base, access: 'view' })
    const [, signature] = token.split('.')
    const forged = Buffer.from(JSON.stringify(base)).toString('base64url')
    expect(verifyTicket(SECRET, `${forged}.${signature}`, '7:Inbox', NOW)).toBe('bad-signature')
  })

  it('refuses garbage', () => {
    for (const token of ['', 'abc', 'abc.', '.abc', 'a.b.c']) {
      expect(verifyTicket(SECRET, token, '7:Inbox', NOW)).not.toEqual(base)
    }
  })
})
