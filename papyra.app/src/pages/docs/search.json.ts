import type { APIRoute } from 'astro';
import { searchSections } from '../../lib/docs-index';

// The docs search index: one record per section, fetched by the search box the
// first time it is used. A few tens of KB; Fuse.js searches it in the browser.
export const GET: APIRoute = async () =>
  new Response(JSON.stringify(await searchSections()), {
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
