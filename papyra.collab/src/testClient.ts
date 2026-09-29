// A scripted collaborator: a Hocuspocus provider plus a headless Papyra
// editor on its doc, so tests and the selftest edit exactly like a browser
// (Lexical updates → @lexical/yjs → wire), without a browser.
import * as Y from 'yjs'
import { HocuspocusProvider } from '@hocuspocus/provider'
import { $getRoot, $isElementNode, $isTextNode, type LexicalNode } from 'lexical'
import {
  createPapyraHeadlessCollab,
  type PapyraHeadlessCollab,
} from '@lyfie/luthor/presets/papyra-collab'

export interface TestClient {
  provider: HocuspocusProvider
  doc: Y.Doc
  collab: PapyraHeadlessCollab
  synced: Promise<void>
  /** Resolves with the close reason when the server closes / refuses this connection. */
  closed: Promise<string>
  /** Insert text into the first text run of top-level block `index`. */
  type(index: number, offset: number, text: string): void
  markdown(): string
  destroy(): void
}

function firstText(node: LexicalNode | null): LexicalNode | null {
  if (!node) return null
  if ($isTextNode(node)) return node
  if ($isElementNode(node)) {
    for (const child of node.getChildren()) {
      const hit = firstText(child)
      if (hit) return hit
    }
  }
  return null
}

export function createTestClient(url: string, room: string, token: string): TestClient {
  const doc = new Y.Doc()
  const collab = createPapyraHeadlessCollab(doc)
  let resolveSynced!: () => void
  let resolveClosed!: (reason: string) => void
  const synced = new Promise<void>((resolve) => (resolveSynced = resolve))
  const closed = new Promise<string>((resolve) => (resolveClosed = resolve))

  const provider = new HocuspocusProvider({
    url,
    name: room,
    document: doc,
    token,
    onSynced: () => resolveSynced(),
    onClose: ({ event }) => resolveClosed(event.reason),
    onAuthenticationFailed: ({ reason }) => resolveClosed(`auth-failed:${reason}`),
  })

  return {
    provider,
    doc,
    collab,
    synced,
    closed,
    type(index, offset, text) {
      collab.editor.update(
        () => {
          const leaf = firstText($getRoot().getChildAtIndex(index))
          if ($isTextNode(leaf)) {
            const content = leaf.getTextContent()
            const at = Math.min(offset, content.length)
            leaf.setTextContent(content.slice(0, at) + text + content.slice(at))
          }
        },
        { discrete: true },
      )
    },
    markdown: () => collab.getMarkdown(),
    destroy() {
      provider.destroy()
      collab.dispose()
    },
  }
}

/** Poll until `check` passes or `timeoutMs` elapses. */
export async function waitFor(check: () => boolean, timeoutMs = 5000, what = 'condition'): Promise<void> {
  const started = Date.now()
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}
