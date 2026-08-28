// Parse the repository's CHANGELOG.md into releases the site can render.
//
// The file is written by the Release workflow, which prepends a section per tag
// from the commits since the previous one. So the format is fixed and worth
// parsing rather than duplicating by hand:
//
//   ## [0.1.2] - 2026-08-20
//
//   - feat: something that shipped (2bab849)
//
// Read at build time from the repo root — the changelog belongs to the project,
// not to the website, and copying it here would guarantee it goes stale.

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Find the repository root.
 *
 * `import.meta.dirname` is wrong here: Astro bundles this module for the build,
 * so at run time it points into the build output rather than at src/lib, and
 * every read silently failed — the changelog page rendered empty with no error.
 * Astro runs the build with the package as its working directory, so walk up
 * from there and confirm by finding the file we actually want.
 */
function findRoot() {
  let dir = process.cwd();
  for (let i = 0; i < 5; i += 1) {
    if (existsSync(resolve(dir, 'CHANGELOG.md'))) return dir;
    dir = resolve(dir, '..');
  }
  return process.cwd();
}

const ROOT = findRoot();

const HEADING = /^##\s*\[?([^\]\s]+)\]?\s*-\s*(\d{4}-\d{2}-\d{2})\s*$/;
const ENTRY = /^-\s+(.*?)\s*(?:\(([0-9a-f]{7,40})\))?\s*$/;

/** Conventional-commit prefix → the label shown on the entry. */
const KINDS = {
  feat: 'Feature',
  fix: 'Fix',
  chore: 'Chore',
  docs: 'Docs',
  refactor: 'Refactor',
  perf: 'Performance',
  test: 'Tests',
  ci: 'CI',
  build: 'Build',
  release: 'Release',
};

export function readChangelog() {
  let raw;
  try {
    raw = readFileSync(resolve(ROOT, 'CHANGELOG.md'), 'utf8');
  } catch {
    return { releases: [], version: null };
  }

  let version = null;
  try {
    version = readFileSync(resolve(ROOT, 'VERSION'), 'utf8').trim();
  } catch {
    /* optional */
  }

  const releases = [];
  let current = null;

  for (const line of raw.split(/\r?\n/)) {
    const heading = HEADING.exec(line);
    if (heading) {
      current = { version: heading[1], date: heading[2], entries: [] };
      releases.push(current);
      continue;
    }

    if (!current) continue;

    const entry = ENTRY.exec(line);
    if (!entry || !entry[1]) continue;

    let text = entry[1];
    let kind = null;

    // "feat: did a thing" → labelled Feature, with the prefix stripped from the
    // sentence so the list reads as prose rather than as commit subjects.
    const prefix = /^(\w+)(?:\([^)]*\))?!?:\s*(.*)$/.exec(text);
    if (prefix && KINDS[prefix[1].toLowerCase()]) {
      kind = KINDS[prefix[1].toLowerCase()];
      text = prefix[2];
    }

    current.entries.push({
      text: text.charAt(0).toUpperCase() + text.slice(1),
      kind,
      sha: entry[2] ?? null,
    });
  }

  return {
    version,
    releases: releases.filter((r) => r.entries.length > 0),
  };
}
