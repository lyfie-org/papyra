// Plain-text views of the site for AI assistants and crawlers, following the
// llms.txt convention (https://llmstxt.org): a short index at /llms.txt and the
// whole documentation in one file at /llms-full.txt. Built from the same data as
// the pages (src/data/about.ts, the docs collection), so they never disagree.

import { readFileSync } from 'node:fs';
import { getCollection, type CollectionEntry } from 'astro:content';
import { FAQ, FEATURES } from '../data/about';
import {
  CREATOR_NAME,
  DESCRIPTION,
  DOCKER_HUB_URL,
  GITHUB_URL,
  LICENSE,
  LUTHOR_URL,
  LYFIE_URL,
  SITE_URL,
} from '../data/site';
import { dockerPulls, roundedCount } from './stats.mjs';

const GROUPS = ['Getting started', 'Living with it', 'In depth', 'Reference'] as const;

export async function sortedDocs(): Promise<CollectionEntry<'docs'>[]> {
  return (await getCollection('docs')).sort((a, b) => {
    const g = GROUPS.indexOf(a.data.group) - GROUPS.indexOf(b.data.group);
    return g !== 0 ? g : a.data.order - b.data.order;
  });
}

/** One docs page as standalone Markdown. */
export function docMarkdown(entry: CollectionEntry<'docs'>): string {
  return `# ${entry.data.title}\n\n> ${entry.data.summary}\n\nSource: ${SITE_URL}/docs/${entry.id}/\n\n${(entry.body ?? '').trim()}\n`;
}

async function intro(): Promise<string> {
  const pulls = await dockerPulls();
  return [
    '# Papyra',
    '',
    `> ${DESCRIPTION}`,
    '',
    'Papyra is for anyone who wants a calm, beautiful notes app they own outright: home-labbers, privacy-minded people, families and small teams.',
    'It feels like Google Keep — a desk of colourful note cards — and goes as deep as a wiki: links, backlinks, search, history and live collaboration.',
    'Every note stays an ordinary Markdown file on the user’s own server, so nothing is ever locked in.',
    '',
    `- Website: ${SITE_URL}`,
    `- Live demo (runs entirely in the browser, no sign-up): ${SITE_URL}/demo/`,
    `- Source code: ${GITHUB_URL} (${LICENSE})`,
    `- Docker image: ${DOCKER_HUB_URL}${pulls !== null && pulls >= 1000 ? ` (${roundedCount(pulls)} pulls)` : ''}`,
    `- Made by Lyfie (${LYFIE_URL}), the open-source organisation founded by ${CREATOR_NAME}; its editor is luthor (${LUTHOR_URL})`,
    '- Price: free. No paid tier, no licence key, no account with Lyfie.',
    '- Privacy: no telemetry, analytics, crash reports or usage pings; no third-party requests from the app.',
    '',
  ].join('\n');
}

function features(): string {
  return ['## Features', '', ...FEATURES.map((f) => `- ${f}`), ''].join('\n');
}

function faq(): string {
  return ['## Frequently asked questions', '', ...FAQ.flatMap(({ q, a }) => [`### ${q}`, '', a, ''])].join('\n');
}

const INSTALL = `## Install

\`\`\`bash
curl -O https://raw.githubusercontent.com/lyfie-org/papyra/main/docker-compose.hub.yml
docker compose -f docker-compose.hub.yml up -d
# then open http://localhost:8080 — the first account created is the admin
\`\`\`
`;

export async function llmsIndex(): Promise<string> {
  const docs = await sortedDocs();
  return [
    await intro(),
    features(),
    INSTALL,
    '## Documentation',
    '',
    ...docs.map((d) => `- [${d.data.title}](${SITE_URL}/docs/${d.id}.md): ${d.data.summary}`),
    '',
    '## Optional',
    '',
    `- [Everything above in one file](${SITE_URL}/llms-full.txt)`,
    `- [Changelog](${SITE_URL}/changelog/): every release`,
    `- [API reference](${SITE_URL}/api/): the REST API`,
    `- [Contributing](${SITE_URL}/contribute/): how to help`,
    `- [Lyfie](${LYFIE_URL}): the organisation behind Papyra`,
    '',
  ].join('\n');
}

export async function llmsFull(): Promise<string> {
  const docs = await sortedDocs();
  let contributing = '';
  try {
    contributing = readFileSync(new URL('../../../CONTRIBUTING.md', import.meta.url), 'utf8');
  } catch {
    // Bundled for the build, so the relative path can move; walk from cwd instead.
    try {
      contributing = readFileSync(`${process.cwd()}/../CONTRIBUTING.md`, 'utf8');
    } catch {
      /* optional */
    }
  }
  return [
    await intro(),
    features(),
    faq(),
    INSTALL,
    ...docs.map((d) => `---\n\n${docMarkdown(d).replace(/^# /, '## ')}`),
    contributing ? `---\n\n${contributing.replace(/^# /, '## ')}` : '',
  ].join('\n');
}
