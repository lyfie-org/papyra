// The collab server's only data path: the API's loopback-only internal
// endpoints. The API stays the single writer of the notes directory (atomic
// write, snapshots, index, mentions); this process only holds the live Yjs
// doc and hands back markdown.

/** A note body as the API has it on disk. */
export interface StoredNote {
  body: string
  /** Content hash of the file on disk; echoed back as `baseHash` on save. */
  hash: string
  /**
   * Persisted Yjs state from the last session, and the file hash it was
   * saved against. Only trusted while that hash still matches the file.
   */
  yState?: Uint8Array
  yStateHash?: string
}

export interface SaveRequest {
  body: string
  /** Hash of the file this body was derived from; 409 when it moved on. */
  baseHash: string
  yState: Uint8Array
  /** User ids that edited since the last save (history attribution). */
  contributors: number[]
}

export type SaveResult =
  | { kind: 'saved'; hash: string }
  /** The file changed underneath the room (git sync, another editor…). */
  | { kind: 'conflict'; current: StoredNote }
  /** Note deleted, trashed or locked — the room must close without saving. */
  | { kind: 'gone' }

export interface NotesApi {
  load(owner: number, note: string): Promise<StoredNote | null>
  save(owner: number, note: string, request: SaveRequest): Promise<SaveResult>
}

type WireNote = { body: string; hash: string; yState?: string | null; yStateHash?: string | null }

function fromWire(note: WireNote): StoredNote {
  return {
    body: note.body,
    hash: note.hash,
    yState: note.yState ? new Uint8Array(Buffer.from(note.yState, 'base64')) : undefined,
    yStateHash: note.yStateHash ?? undefined,
  }
}

/** HTTP client for Papyra.Api `/internal/collab/*`, authenticated by the shared secret. */
export function createHttpNotesApi(baseUrl: string, secret: string): NotesApi {
  const url = (owner: number, note: string) =>
    `${baseUrl.replace(/\/$/, '')}/internal/collab/notes/${owner}/${encodeURIComponent(note)}`
  const headers = { 'X-Collab-Secret': secret }

  return {
    async load(owner, note) {
      const res = await fetch(url(owner, note), { headers, signal: AbortSignal.timeout(15_000) })
      if (res.status === 404 || res.status === 410) return null
      if (!res.ok) throw new Error(`load ${owner}:${note} failed: HTTP ${res.status}`)
      return fromWire((await res.json()) as WireNote)
    },

    async save(owner, note, request) {
      const res = await fetch(url(owner, note), {
        method: 'PUT',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          body: request.body,
          baseHash: request.baseHash,
          yState: Buffer.from(request.yState).toString('base64'),
          contributors: request.contributors,
        }),
        signal: AbortSignal.timeout(30_000),
      })
      if (res.status === 404 || res.status === 410) return { kind: 'gone' }
      if (res.status === 409) {
        return { kind: 'conflict', current: fromWire((await res.json()) as WireNote) }
      }
      if (!res.ok) throw new Error(`save ${owner}:${note} failed: HTTP ${res.status}`)
      const { hash } = (await res.json()) as { hash: string }
      return { kind: 'saved', hash }
    },
  }
}
