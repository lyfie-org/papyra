import type { APIRoute, GetStaticPaths } from 'astro';
import { docMarkdown, sortedDocs } from '../../lib/llms';

// Every docs page as plain Markdown at /docs/<page>.md, for AI assistants,
// scripts and anyone who would rather read the source.
export const getStaticPaths = (async () =>
  (await sortedDocs()).map((entry) => ({ params: { slug: entry.id }, props: { entry } }))) satisfies GetStaticPaths;

export const GET: APIRoute = ({ props }) =>
  new Response(docMarkdown(props.entry), { headers: { 'Content-Type': 'text/markdown; charset=utf-8' } });
