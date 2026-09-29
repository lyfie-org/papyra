// In-memory NotesApi with the same contract as Papyra.Api's internal
// endpoints (hash-checked saves, 409 with the current file, gone notes).
// Used by the selftest and the test suite.
import { createHash } from 'node:crypto'
import type { NotesApi, SaveRequest, StoredNote } from './api'

export function contentHash(body: string): string {
  return createHash('sha256').update(body, 'utf8').digest('hex')
}

export interface MemoryNote {
  body: string
  yState?: Uint8Array
  yStateHash?: string
  gone?: boolean
}

export interface MemoryNotesApi extends NotesApi {
  notes: Map<string, MemoryNote>
  saves: Array<{ room: string } & SaveRequest>
  /** Simulate an edit made to the file outside the room. */
  writeExternally(room: string, body: string): StoredNote
  current(room: string): StoredNote
}

export function createMemoryNotesApi(initial: Record<string, string> = {}): MemoryNotesApi {
  const notes = new Map<string, MemoryNote>(
    Object.entries(initial).map(([room, body]) => [room, { body }]),
  )
  const saves: MemoryNotesApi['saves'] = []

  const current = (room: string): StoredNote => {
    const note = notes.get(room)!
    return { body: note.body, hash: contentHash(note.body), yState: note.yState, yStateHash: note.yStateHash }
  }

  return {
    notes,
    saves,
    current,
    writeExternally(room, body) {
      const note = notes.get(room)!
      note.body = body
      return current(room)
    },
    async load(owner, note) {
      const room = `${owner}:${note}`
      const stored = notes.get(room)
      return stored && !stored.gone ? current(room) : null
    },
    async save(owner, note, request) {
      const room = `${owner}:${note}`
      const stored = notes.get(room)
      if (!stored || stored.gone) return { kind: 'gone' }
      if (contentHash(stored.body) !== request.baseHash) return { kind: 'conflict', current: current(room) }
      saves.push({ room, ...request })
      stored.body = request.body
      const hash = contentHash(request.body)
      stored.yState = request.yState
      stored.yStateHash = hash
      return { kind: 'saved', hash }
    },
  }
}
