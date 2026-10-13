import { describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import { createPapyraHeadlessCollab } from '@lyfie/luthor/presets/papyra-collab'
import { createMemoryNotesApi } from './memoryApi'
import { AGENT_PRESENCE_MS, applyMarkdownMinimal, EPOCH_KEY, ROOM_META, RoomRegistry } from './rooms'

const ROOM = '7:note'
const quiet = { info: () => {}, warn: () => {}, error: vi.fn() }

function setup(body: string) {
  const api = createMemoryNotesApi({ [ROOM]: body })
  const closeRoom = vi.fn()
  const rooms = new RoomRegistry({ api, log: quiet, closeRoom })
  const doc = new Y.Doc()
  // What a peer sees: a second headless editor on a doc synced with the room.
  const peer = () => {
    const peerDoc = new Y.Doc()
    Y.applyUpdate(peerDoc, Y.encodeStateAsUpdate(doc))
    return createPapyraHeadlessCollab(peerDoc)
  }
  return { api, closeRoom, rooms, doc, peer }
}

function edit(doc: Y.Doc, markdown: string) {
  // Stand-in for a client edit: a second binding on the same doc.
  const collab = createPapyraHeadlessCollab(doc)
  applyMarkdownMinimal(collab, markdown)
  collab.dispose()
}

describe('RoomRegistry', () => {
  it('seeds an empty room from the file and saves nothing until it changes', async () => {
    const { api, rooms, doc, peer } = setup('# Title\n\nBody')
    await rooms.load(ROOM, doc)
    expect(peer().getMarkdown()).toBe('# Title\n\nBody')

    await rooms.store(ROOM)
    expect(api.saves).toHaveLength(0)
  })

  it('gives an empty note one editable paragraph', async () => {
    const { rooms, doc } = setup('')
    await rooms.load(ROOM, doc)
    const collab = createPapyraHeadlessCollab(doc)
    expect(collab.editor.getEditorState().toJSON().root.children).toHaveLength(1)
  })

  it('saves edits against the file hash and records contributors', async () => {
    const { api, rooms, doc } = setup('Hello')
    await rooms.load(ROOM, doc)
    edit(doc, 'Hello there')
    rooms.touch(ROOM, 3)
    await rooms.store(ROOM)

    expect(api.notes.get(ROOM)!.body).toBe('Hello there')
    expect(api.saves[0]!.contributors).toEqual([3])
  })

  it('reopens from persisted Yjs state while the file is unchanged', async () => {
    const { api, rooms, doc } = setup('Hello')
    await rooms.load(ROOM, doc)
    edit(doc, 'Hello again')
    await rooms.store(ROOM)
    rooms.dispose(ROOM)

    const reopened = new Y.Doc()
    await rooms.load(ROOM, reopened)
    // Same Yjs history (not re-seeded): the state vector carries the edits.
    expect(Y.encodeStateVector(reopened)).toEqual(Y.encodeStateVector(doc))
    expect(api.notes.get(ROOM)!.body).toBe('Hello again')
  })

  it('ignores persisted state once the file changed on disk', async () => {
    const { api, rooms, doc } = setup('Hello')
    await rooms.load(ROOM, doc)
    edit(doc, 'Hello again')
    await rooms.store(ROOM)
    rooms.dispose(ROOM)
    api.writeExternally(ROOM, 'Rewritten by git')

    const reopened = new Y.Doc()
    await rooms.load(ROOM, reopened)
    expect(createPapyraHeadlessCollab(reopened).getMarkdown()).toBe('Rewritten by git')
  })

  it('keeps the lineage epoch across persisted reopens and renews it on a rebuild', async () => {
    const { api, rooms, doc } = setup('Hello')
    await rooms.load(ROOM, doc)
    const epoch = doc.getMap(ROOM_META).get(EPOCH_KEY)
    expect(typeof epoch).toBe('string')
    edit(doc, 'Hello again')
    await rooms.store(ROOM)
    rooms.dispose(ROOM)

    const reopened = new Y.Doc()
    await rooms.load(ROOM, reopened)
    expect(reopened.getMap(ROOM_META).get(EPOCH_KEY)).toBe(epoch)
    rooms.dispose(ROOM)

    // Rebuilt from the file: a new Yjs lineage, so a new epoch.
    api.writeExternally(ROOM, 'Rewritten by git')
    const rebuilt = new Y.Doc()
    await rooms.load(ROOM, rebuilt)
    expect(rebuilt.getMap(ROOM_META).get(EPOCH_KEY)).not.toBe(epoch)
  })

  it('merges a file edit made mid-session instead of overwriting it', async () => {
    const { api, rooms, doc, peer } = setup('Intro\n\nMiddle\n\nOutro')
    await rooms.load(ROOM, doc)
    edit(doc, 'Intro (room)\n\nMiddle\n\nOutro')
    api.writeExternally(ROOM, 'Intro\n\nMiddle\n\nOutro (file)')

    await rooms.store(ROOM) // 409 → merge → retry
    const merged = 'Intro (room)\n\nMiddle\n\nOutro (file)'
    expect(api.notes.get(ROOM)!.body).toBe(merged)
    expect(peer().getMarkdown()).toBe(merged)
  })

  it('counts opens, saves and conflicts for /healthz', async () => {
    const { api, rooms, doc } = setup('Intro\n\nMiddle')
    await rooms.load(ROOM, doc)
    edit(doc, 'Intro (room)\n\nMiddle')
    api.writeExternally(ROOM, 'Intro\n\nMiddle (file)')
    await rooms.store(ROOM)
    expect(rooms.stats).toMatchObject({ opened: 1, saves: 1, conflicts: 1, failures: 0 })
    expect(rooms.stats.maxSaveMs).toBeGreaterThanOrEqual(rooms.stats.lastSaveMs)
  })

  it('adopts an external change pushed by the API', async () => {
    const { api, rooms, doc, peer } = setup('One\n\nTwo')
    await rooms.load(ROOM, doc)
    const current = api.writeExternally(ROOM, 'One\n\nTwo\n\nThree')
    expect(await rooms.external(ROOM, current)).toBe(true)
    expect(peer().getMarkdown()).toBe('One\n\nTwo\n\nThree')
  })

  it('replaces the room with a restored version instead of merging it', async () => {
    const { api, rooms, doc, peer } = setup('Intro\n\nMiddle')
    await rooms.load(ROOM, doc)
    edit(doc, 'Intro (typed)\n\nMiddle')
    const restored = api.writeExternally(ROOM, 'Old intro\n\nOld middle')
    expect(await rooms.restore(ROOM, restored)).toBe(true)
    expect(peer().getMarkdown()).toBe('Old intro\n\nOld middle')

    // The restored file is the new ancestor: nothing left to save, nothing re-merged.
    await rooms.store(ROOM)
    expect(api.saves).toHaveLength(0)
    expect(api.notes.get(ROOM)!.body).toBe('Old intro\n\nOld middle')
  })

  it('closes the room and stops saving when the note is gone', async () => {
    const { api, closeRoom, rooms, doc } = setup('Hello')
    await rooms.load(ROOM, doc)
    api.notes.get(ROOM)!.gone = true
    edit(doc, 'Hello there')
    await rooms.store(ROOM)
    expect(closeRoom).toHaveBeenCalledWith(ROOM)

    api.notes.get(ROOM)!.gone = false
    await rooms.store(ROOM)
    expect(api.saves).toHaveLength(0)
  })

  it('serializes concurrent store/external calls for one room', async () => {
    const { api, rooms, doc } = setup('A\n\nB')
    await rooms.load(ROOM, doc)
    edit(doc, 'A1\n\nB')
    const current = api.writeExternally(ROOM, 'A\n\nB1')
    await Promise.all([rooms.store(ROOM), rooms.external(ROOM, current), rooms.store(ROOM)])
    expect(api.notes.get(ROOM)!.body).toBe('A1\n\nB1')
  })
})

describe('agent edits', () => {
  const agent = { contributor: -4, uid: 7, username: 'rahul', name: 'claude-japan' }
  const presenceDoc = () => {
    const states: Array<Record<string, unknown> | null> = []
    const doc = Object.assign(new Y.Doc(), { awareness: { setLocalState: (s: Record<string, unknown> | null) => states.push(s) } })
    return { doc, states }
  }

  it('merges against the version the agent read, keeping unsaved typing', async () => {
    const { api, rooms, doc, peer } = setup('Day 1\n\nDay 2\n\nDay 3')
    await rooms.load(ROOM, doc)
    const read = api.current(ROOM)
    edit(doc, 'Day 1 (typed live)\n\nDay 2\n\nDay 3') // not saved yet

    const result = await rooms.agentEdit(ROOM, { baseHash: read.hash, body: 'Day 1\n\nDay 2\n\nDay 3 — Kyoto', agent })
    const merged = 'Day 1 (typed live)\n\nDay 2\n\nDay 3 — Kyoto'
    expect(result).toMatchObject({ kind: 'applied', body: merged, conflicted: false })
    expect(peer().getMarkdown()).toBe(merged)
    expect(api.notes.get(ROOM)!.body).toBe(merged)
    expect(api.saves.at(-1)!.contributors).toContain(-4)
  })

  it('still merges when the room saved between the read and the write', async () => {
    const { api, rooms, doc, peer } = setup('A\n\nB')
    await rooms.load(ROOM, doc)
    const read = api.current(ROOM)
    edit(doc, 'A typed\n\nB')
    await rooms.store(ROOM) // the file moved on past what the agent read

    const result = await rooms.agentEdit(ROOM, { baseHash: read.hash, body: 'A\n\nB by agent', agent })
    expect(result.kind).toBe('applied')
    expect(peer().getMarkdown()).toBe('A typed\n\nB by agent')
  })

  it('sends an agent that read an unknown version back to re-read, after saving the room', async () => {
    const { api, rooms, doc } = setup('One')
    await rooms.load(ROOM, doc)
    edit(doc, 'One, typed')

    const result = await rooms.agentEdit(ROOM, { baseHash: 'nope', body: 'Clobber', agent })
    expect(result).toEqual({ kind: 'stale', body: 'One, typed', hash: api.current(ROOM).hash })
    expect(api.notes.get(ROOM)!.body).toBe('One, typed')
  })

  it('reports a note with no room as not live', async () => {
    const { rooms } = setup('x')
    expect(await rooms.agentEdit(ROOM, { baseHash: 'h', body: 'y', agent })).toEqual({ kind: 'not-live' })
  })

  it('shows the agent in presence for a while, then clears it', async () => {
    vi.useFakeTimers()
    try {
      const api = createMemoryNotesApi({ [ROOM]: 'Hi' })
      const rooms = new RoomRegistry({ api, log: quiet, closeRoom: vi.fn() })
      const { doc, states } = presenceDoc()
      await rooms.load(ROOM, doc)
      await rooms.agentEdit(ROOM, { baseHash: api.current(ROOM).hash, body: 'Hi there', agent })
      expect(states.at(-1)).toMatchObject({
        name: 'claude-japan',
        awarenessData: { uid: 7, username: 'rahul', agent: true },
      })
      vi.advanceTimersByTime(AGENT_PRESENCE_MS + 1)
      expect(states.at(-1)).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('applyMarkdownMinimal', () => {
  it('keeps untouched blocks as the same Yjs items (peers keep their carets)', () => {
    const doc = new Y.Doc()
    const collab = createPapyraHeadlessCollab(doc)
    collab.setMarkdown('Keep me\n\nChange me\n\nKeep me too')
    const root = doc.get('root', Y.XmlText)
    const before = root.toDelta().map((op: { insert: unknown }) => op.insert)

    applyMarkdownMinimal(collab, 'Keep me\n\nChanged\n\nKeep me too')
    const after = root.toDelta().map((op: { insert: unknown }) => op.insert)

    expect(collab.getMarkdown()).toBe('Keep me\n\nChanged\n\nKeep me too')
    expect(after[0]).toBe(before[0])
    expect(after[2]).toBe(before[2])
    expect(after[1]).not.toBe(before[1])
  })
})

// The room serializes to markdown server-side, so the engine and the editor
// must agree on every way an attachment is written: opening a note in a live
// room must never rewrite a single byte of it.
describe('media round-trip through a room', () => {
  const corpus = [
    '![[photo.png]]',
    '![[photo.png|480]]',
    '![[clip.mp4|640x360]]',
    '![[photo.png|A sunset|300]]',
    '![[photo.png|300]] <!-- align:center --> <!-- caption:Hello -->',
    '![[report.pdf#page=3]]',
    'before ![[inline.gif]] after',
    '![[a.png]] ![[b.png]]',
    '![alt|300](https://example.com/x.png)',
    // Canonical form. A hand-written watch?v= URL is still normalized to this
    // on the first save (luthor follow-up, see MEDIA_IMPLEMENTATION_PLAN S9).
    '![[youtube:https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ|A talk|640x360]]',
    '| a | b |\n| --- | --- |\n| ![[t.png\\|200]] | x |',
  ]

  it.each(corpus)('%s', async (body) => {
    const { api, rooms, doc, peer } = setup(`Intro\n\n${body}\n\nOutro`)
    await rooms.load(ROOM, doc)
    expect(peer().getMarkdown()).toBe(`Intro\n\n${body}\n\nOutro`)
    await rooms.store(ROOM)
    expect(api.saves).toHaveLength(0)
  })

  it('a peer resizing an embed saves exactly that change', async () => {
    const { api, rooms, doc } = setup('Intro\n\n![[photo.png]]\n\nOutro')
    await rooms.load(ROOM, doc)
    edit(doc, 'Intro\n\n![[photo.png|320]]\n\nOutro')
    await rooms.store(ROOM)
    expect(api.saves.at(-1)?.body).toBe('Intro\n\n![[photo.png|320]]\n\nOutro')
  })
})
