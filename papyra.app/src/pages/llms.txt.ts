import type { APIRoute } from 'astro';
import { llmsIndex } from '../lib/llms';

// https://llmstxt.org — a short, plain-text map of the site for AI assistants.
export const GET: APIRoute = async () =>
  new Response(await llmsIndex(), { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
