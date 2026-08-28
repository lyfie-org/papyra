// Regenerate src/data/openapi.json from the API itself.
//
// The document is committed rather than generated during the site build: the
// site would otherwise need the .NET SDK and a booted API on every deploy, to
// produce a file that only changes when papyra.api changes. Committing it also
// makes an API change show up as a reviewable diff.
//
// Re-run this whenever endpoints are added, removed or re-tagged:
//   pnpm --filter papyra-app run openapi
//
// It boots the API on a throwaway data directory and a spare port, so it never
// touches a real vault.

import { spawn, execFileSync } from 'node:child_process';
import { rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const API_DIR = resolve(import.meta.dirname, '../../papyra.api/src/Papyra.Api');
const OUT = resolve(import.meta.dirname, '../src/data/openapi.json');
const DATA_DIR = '.openapi-tmp';
const PORT = 5299;
const BASE = `http://localhost:${PORT}`;

console.log('openapi: booting the API on a throwaway data dir…');

const api = spawn(
  'dotnet',
  ['run', '--no-launch-profile', '--urls', BASE, '--', `--Papyra:DataDir=${DATA_DIR}`],
  // No shell: `dotnet` resolves fine on its own, and a shell wrapper both
  // triggers Node's arg-escaping deprecation and hides the real child from kill().
  { cwd: API_DIR, stdio: 'ignore' },
);

let stopped = false;

/**
 * Stop the API and clean up.
 *
 * `dotnet run` spawns the built app as its own child, so killing the launcher
 * can leave the server holding the port and the data directory. taskkill /T ends
 * the whole tree on Windows; elsewhere the process group is enough.
 */
const stop = async () => {
  if (stopped) return;
  stopped = true;
  try {
    if (process.platform === 'win32' && api.pid) {
      execFileSync('taskkill', ['/pid', String(api.pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      api.kill();
    }
  } catch {
    /* already gone */
  }
  // Give the file handles a moment to release before removing the directory.
  await new Promise((r) => setTimeout(r, 500));
  await rm(resolve(API_DIR, DATA_DIR), { recursive: true, force: true }).catch(() => {});
};

try {
  // Boot includes a cold-boot reconcile before the port opens, so this is not
  // instant even on an empty vault.
  let up = false;
  for (let i = 0; i < 90; i += 1) {
    await new Promise((r) => setTimeout(r, 1000));
    try {
      const res = await fetch(`${BASE}/health`);
      if (res.ok) {
        up = true;
        break;
      }
    } catch {
      /* not listening yet */
    }
  }
  if (!up) throw new Error(`the API never answered ${BASE}/health`);

  const res = await fetch(`${BASE}/openapi/v1.json`);
  if (!res.ok) throw new Error(`GET /openapi/v1.json returned ${res.status}`);

  const doc = await res.json();
  const paths = Object.keys(doc.paths ?? {});
  const operations = paths.flatMap((p) => Object.keys(doc.paths[p]));

  // Pretty-printed so a change to one endpoint is a small, readable diff rather
  // than one enormous line.
  await writeFile(OUT, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');

  console.log(
    `openapi: ${paths.length} paths, ${operations.length} operations -> src/data/openapi.json`,
  );
} catch (err) {
  console.error(`openapi: ${err.message}`);
  await stop();
  process.exitCode = 1;
}

await stop();
