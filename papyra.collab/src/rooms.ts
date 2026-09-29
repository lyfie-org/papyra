// Live rooms: one per open shared note. Each room binds a headless Papyra
// editor to the Hocuspocus Y.Doc so the server can read the doc as markdown
// (to save) and write markdown into it (to adopt external file edits).
import { randomUUID } from 'node:crypto'
import * as Y from 'yjs'
import {
  $createParagraphNode,
  $getRoot,
  $parseSerializedNode,
  type LexicalNode,
  type SerializedLexicalNode,
} from 'lexical'
import {
  createPapyraHeadlessCollab,
  papyraMarkdownToJSON,
  type PapyraHeadlessCollab,
} from '@lyfie/luthor/presets/papyra-collab'
import type { NotesApi, StoredNote } from './api'
import { mergeMarkdown } from './merge'
import { parseRoomName } from './ticket'

// luthor once serialized placeholders instead of embeds; that text is never
// the note and must never reach disk (mirrors papyra.web lib/bridgePlaceholder).
const BRIDGE_PLACEHOLDER = /\[Unsupported [\w-]+ preserved in markdown metadata\]/

/**
 * Room metadata lives beside the editor's root type. `epoch` names the doc's
 * Yjs lineage: it changes whenever the room is rebuilt from the file instead
 * of from persisted state. Browsers key their offline (IndexedDB) copy by it,
 * because updates from one lineage merged into another duplicate content.
 */
export const ROOM_META = 'papyra'
export const EPOCH_KEY = 'epoch'

export interface Logger {
  info(message: string): void
  warn(message: string): void
  error(message: string): void
}

interface Room {
  owner: number
  note: string
  collab: PapyraHeadlessCollab
  /** Room markdown as of the last load/save — the merge ancestor. */
  base: string
  /** Hash of the file on disk that `base` corresponds to. */
  baseHash: string
  contributors: Set<number>
  /** Note deleted/trashed/locked: never save again. */
  gone: boolean
  /** Serializes store/external/close so they never interleave. */
  queue: Promise<unknown>
}

function serial<T>(room: Room, task: () => Promise<T>): Promise<T> {
  const next = room.queue.then(task, task)
  room.queue = next.catch(() => undefined)
  return next
}

/**
 * Replace the document body with `markdown`, touching only the top-level
 * blocks that differ. Untouched blocks keep their Yjs identity, so peers'
 * carets and selections inside them stay exactly where they were.
 */
export function applyMarkdownMinimal(collab: PapyraHeadlessCollab, markdown: string): void {
  const target = ((papyraMarkdownToJSON(markdown) as { root: { children?: SerializedLexicalNode[] } })
    .root.children ?? [])
  const targetKeys = target.map((node) => JSON.stringify(node))
  const currentKeys = (
    (collab.editor.getEditorState().toJSON() as { root: { children: SerializedLexicalNode[] } }).root
      .children
  ).map((node) => JSON.stringify(node))

  // LCS over serialized blocks → which current blocks survive, in order.
  const n = currentKeys.length
  const m = targetKeys.length
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i]![j] =
        currentKeys[i] === targetKeys[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!)
    }
  }
  const keepAt = new Map<number, number>() // target index → current index
  for (let i = 0, j = 0; i < n && j < m; ) {
    if (currentKeys[i] === targetKeys[j]) {
      keepAt.set(j, i)
      i += 1
      j += 1
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) i += 1
    else j += 1
  }
  if (keepAt.size === n && n === m) return

  collab.editor.update(
    () => {
      const root = $getRoot()
      const current = root.getChildren()
      const kept = new Set(keepAt.values())
      current.forEach((node, index) => {
        if (!kept.has(index)) node.remove()
      })
      let previous: LexicalNode | null = null
      target.forEach((serialized, j) => {
        const keptIndex = keepAt.get(j)
        const node: LexicalNode = keptIndex !== undefined ? current[keptIndex]! : $parseSerializedNode(serialized)
        if (keptIndex === undefined) {
          if (previous) previous.insertAfter(node)
          else {
            const first = root.getFirstChild()
            if (first) first.insertBefore(node)
            else root.append(node)
          }
        }
        previous = node
      })
    },
    { discrete: true },
  )
  ensureEditable(collab)
}

/**
 * A document with no blocks has no place for a caret; clients never
 * bootstrap, so the server guarantees at least one (empty) paragraph.
 */
export function ensureEditable(collab: PapyraHeadlessCollab): void {
  if (collab.editor.getEditorState().read(() => $getRoot().getChildrenSize()) > 0) return
  collab.editor.update(
    () => {
      $getRoot().append($createParagraphNode())
    },
    { discrete: true },
  )
}

export interface RoomRegistryOptions {
  api: NotesApi
  log: Logger
  /** Close every connection of a room (after it is gone). */
  closeRoom: (documentName: string) => void
}

export class RoomRegistry {
  private readonly rooms = new Map<string, Room>()
  private readonly api: NotesApi
  private readonly log: Logger
  private readonly closeRoom: (documentName: string) => void

  constructor(options: RoomRegistryOptions) {
    this.api = options.api
    this.log = options.log
    this.closeRoom = options.closeRoom
  }

  get size(): number {
    return this.rooms.size
  }

  has(documentName: string): boolean {
    return this.rooms.has(documentName)
  }

  /** Hydrate `document` for a room: persisted Yjs state if still valid, else the file. */
  async load(documentName: string, document: Y.Doc): Promise<void> {
    const parsed = parseRoomName(documentName)
    if (!parsed) throw new Error(`invalid room name "${documentName}"`)
    const stored = await this.api.load(parsed.owner, parsed.note)
    if (!stored) throw new Error(`note ${documentName} not found`)

    // A persisted state is only trustworthy while the file is exactly what it
    // was saved against; otherwise the file (the source of truth) wins.
    const useState = stored.yState !== undefined && stored.yStateHash === stored.hash
    if (useState) Y.applyUpdate(document, stored.yState!)

    const collab = createPapyraHeadlessCollab(document, {
      onError: (error) => this.log.error(`[${documentName}] editor: ${error.message}`),
    })
    // Only the server ever seeds a room (clients never bootstrap), and only an
    // empty one — so content can never be duplicated.
    if (collab.isEmpty()) collab.setMarkdown(stored.body)
    ensureEditable(collab)
    const meta = document.getMap<string>(ROOM_META)
    if (!useState || typeof meta.get(EPOCH_KEY) !== 'string') meta.set(EPOCH_KEY, randomUUID())

    this.rooms.set(documentName, {
      owner: parsed.owner,
      note: parsed.note,
      collab,
      base: collab.getMarkdown(),
      baseHash: stored.hash,
      contributors: new Set(),
      gone: false,
      queue: Promise.resolve(),
    })
    this.log.info(`[${documentName}] opened (${useState ? 'persisted state' : 'from file'})`)
  }

  /** Record who edited, for history attribution. */
  touch(documentName: string, uid: number | undefined): void {
    if (uid !== undefined) this.rooms.get(documentName)?.contributors.add(uid)
  }

  /** Persist the room's markdown through the API (Hocuspocus onStoreDocument). */
  async store(documentName: string): Promise<void> {
    const room = this.rooms.get(documentName)
    if (!room) return
    await serial(room, () => this.save(documentName, room))
  }

  private async save(documentName: string, room: Room): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (room.gone) return
      const markdown = room.collab.getMarkdown()
      if (BRIDGE_PLACEHOLDER.test(markdown)) {
        this.log.error(`[${documentName}] refusing to save placeholder serialization`)
        return
      }
      if (markdown === room.base) return

      const result = await this.api.save(room.owner, room.note, {
        body: markdown,
        baseHash: room.baseHash,
        yState: Y.encodeStateAsUpdate(room.collab.doc),
        contributors: [...room.contributors],
      })
      if (result.kind === 'saved') {
        room.base = markdown
        room.baseHash = result.hash
        room.contributors.clear()
        return
      }
      if (result.kind === 'gone') {
        this.markGone(documentName, room)
        return
      }
      // The file moved on underneath us: fold its changes into the room, then
      // retry against the new hash.
      this.reconcile(documentName, room, result.current)
    }
    this.log.warn(`[${documentName}] save still conflicting after retries; will retry on next change`)
  }

  /** The API saw the file change outside the room (watcher / git sync). */
  async external(documentName: string, current: StoredNote): Promise<boolean> {
    const room = this.rooms.get(documentName)
    if (!room) return false
    await serial(room, async () => {
      if (current.hash === room.baseHash) return
      this.reconcile(documentName, room, current)
      await this.save(documentName, room)
    })
    return true
  }

  /**
   * The owner restored an older version: it *replaces* the room's text (no
   * merge — that is what restore means). Applied in place as a server-origin
   * change so everyone sees it live with their caret kept, and the restored
   * file becomes the new common ancestor.
   */
  async restore(documentName: string, current: StoredNote): Promise<boolean> {
    const room = this.rooms.get(documentName)
    if (!room) return false
    await serial(room, async () => {
      applyMarkdownMinimal(room.collab, current.body)
      room.base = normalize(current.body)
      room.baseHash = current.hash
      room.contributors.clear()
    })
    return true
  }

  private reconcile(documentName: string, room: Room, current: StoredNote): void {
    const ours = room.collab.getMarkdown()
    const merged = mergeMarkdown(room.base, ours, current.body)
    if (merged.conflicted) {
      this.log.warn(`[${documentName}] concurrent file + room edits; kept both versions of the clashing blocks`)
    }
    applyMarkdownMinimal(room.collab, merged.markdown)
    // The file on disk is the new common ancestor.
    room.base = normalize(current.body)
    room.baseHash = current.hash
  }

  /** Stop saving and disconnect everyone (note deleted, trashed or locked). */
  async close(documentName: string, mode: 'flush' | 'discard'): Promise<void> {
    const room = this.rooms.get(documentName)
    if (room) {
      await serial(room, async () => {
        if (mode === 'flush') await this.save(documentName, room)
        room.gone = true
      })
    }
    this.closeRoom(documentName)
  }

  private markGone(documentName: string, room: Room): void {
    room.gone = true
    this.log.info(`[${documentName}] note is gone; closing room without saving`)
    this.closeRoom(documentName)
  }

  /** Hocuspocus unloaded the document (last client left, after its final store). */
  dispose(documentName: string): void {
    const room = this.rooms.get(documentName)
    if (!room) return
    room.collab.dispose()
    this.rooms.delete(documentName)
  }
}

/** Markdown as a room would serialize it (so ancestors compare like-for-like). */
function normalize(markdown: string): string {
  const doc = new Y.Doc()
  const collab = createPapyraHeadlessCollab(doc)
  try {
    collab.setMarkdown(markdown)
    return collab.getMarkdown()
  } finally {
    collab.dispose()
    doc.destroy()
  }
}
