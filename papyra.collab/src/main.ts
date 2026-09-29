// Entry point. Normally spawned by Papyra.Api's CollabHost, which passes:
//   PAPYRA_COLLAB_SECRET   per-boot shared secret (required)
//   PAPYRA_API_URL         loopback base URL of the API's internal endpoints
//   PAPYRA_COLLAB_PORT     port to bind (0 = pick a free one; default 0)
// and reads the "PAPYRA_COLLAB_READY port=N" line from stdout to learn where
// to proxy /collab. `--selftest` boots the bundle against an in-memory API and
// exits 0/1 — CI and the release smoke test run it on the built dist/server.mjs.
import { createHttpNotesApi } from './api'
import { runSelftest } from './selftest'
import { createCollabServer } from './server'

const log = {
  info: (message: string) => console.log(`[collab] ${message}`),
  warn: (message: string) => console.warn(`[collab] ${message}`),
  error: (message: string) => console.error(`[collab] ${message}`),
}

// Yjs warns whenever @lexical/yjs reads a shared type before it is attached
// to a doc — which the binding does by design while hydrating a room. It is
// harmless and would otherwise print on every room open; drop only that line.
const YJS_PREMATURE_ACCESS = 'Invalid access: Add Yjs type to a document before reading data.'
const warn = console.warn.bind(console)
console.warn = (...args: unknown[]) => {
  if (args[0] === YJS_PREMATURE_ACCESS) return
  warn(...args)
}

async function main(): Promise<void> {
  if (process.argv.includes('--selftest')) {
    process.exitCode = (await runSelftest(log)) ? 0 : 1
    // Let sockets finish closing before exiting (an immediate exit mid-close
    // trips a libuv assertion on Windows).
    setTimeout(() => process.exit(), 250)
    return
  }

  const secret = process.env.PAPYRA_COLLAB_SECRET
  const apiUrl = process.env.PAPYRA_API_URL
  if (!secret || secret.length < 32 || !apiUrl) {
    log.error('PAPYRA_COLLAB_SECRET (>=32 chars) and PAPYRA_API_URL are required')
    process.exit(2)
  }

  const collab = createCollabServer({
    secret,
    api: createHttpNotesApi(apiUrl, secret),
    log,
    port: Number(process.env.PAPYRA_COLLAB_PORT ?? 0),
    address: '127.0.0.1',
  })
  const port = await collab.listen()
  // Machine-readable handshake for CollabHost — keep the exact format.
  console.log(`PAPYRA_COLLAB_READY port=${port}`)

  let stopping = false
  const shutdown = async (signal: string) => {
    if (stopping) return
    stopping = true
    log.info(`${signal}: saving open rooms and shutting down`)
    collab.server.hocuspocus.flushPendingStores()
    await collab.stop()
    process.exit(0)
  }
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  process.on('SIGINT', () => void shutdown('SIGINT'))
  // When spawned by the API it owns our lifetime: when it goes away (our stdin
  // pipe closes), so do we — never leave an orphan holding rooms. Opt-in, so a
  // dev run from a terminal/concurrently isn't killed by a closed stdin.
  if (process.env.PAPYRA_COLLAB_EXIT_WITH_PARENT === '1') {
    process.stdin.on('end', () => void shutdown('parent-exit'))
    process.stdin.resume()
  }
}

main().catch((error: Error) => {
  log.error(`fatal: ${error.stack ?? error.message}`)
  process.exit(1)
})
