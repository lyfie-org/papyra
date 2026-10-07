// The docs, split into sections: for the sidebar's per-page contents and for
// the fuzzy search index (/docs/search.json). Heading slugs come from Astro's
// own render, so every link lands on the id the page actually has.

import { render, type CollectionEntry } from 'astro:content';
import { sortedDocs } from './llms';

export interface DocHeading {
  slug: string;
  text: string;
}

export interface SearchSection {
  /** Page title. */
  t: string;
  /** Section heading — empty for a page's introduction. */
  h: string;
  /** Link, with the section's #fragment. */
  u: string;
  /** The section as plain text. */
  x: string;
}

const headingCache = new Map<string, DocHeading[]>();

/** A page's h2s, in order. */
export async function pageHeadings(entry: CollectionEntry<'docs'>): Promise<DocHeading[]> {
  if (!headingCache.has(entry.id)) {
    const { headings } = await render(entry);
    headingCache.set(
      entry.id,
      headings.filter((h) => h.depth === 2).map((h) => ({ slug: h.slug, text: h.text })),
    );
  }
  return headingCache.get(entry.id)!;
}

/** Markdown → readable plain text, good enough for matching and snippets. */
function plain(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, (block) => block.replace(/```\w*/g, ' '))
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[`*_>#|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export async function searchSections(): Promise<SearchSection[]> {
  const out: SearchSection[] = [];
  for (const entry of await sortedDocs()) {
    const headings = await pageHeadings(entry);
    const url = `/docs/${entry.id}/`;
    // Split on level-2 headings that are not inside a code fence.
    const chunks: { heading: string; lines: string[] }[] = [{ heading: '', lines: [entry.data.summary] }];
    let fenced = false;
    for (const line of (entry.body ?? '').split(/\r?\n/)) {
      if (/^```/.test(line)) fenced = !fenced;
      const m = !fenced && /^##\s+(.+?)\s*$/.exec(line);
      if (m) chunks.push({ heading: m[1], lines: [] });
      else chunks[chunks.length - 1].lines.push(line);
    }
    let h2 = 0;
    for (const chunk of chunks) {
      const heading = chunk.heading ? headings[h2++] : undefined;
      out.push({
        t: entry.data.title,
        h: heading?.text ?? chunk.heading,
        u: heading ? `${url}#${heading.slug}` : url,
        x: plain(chunk.lines.join('\n')).slice(0, 900),
      });
    }
  }
  return out;
}
