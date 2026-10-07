import type { APIRoute } from 'astro';
import { llmsFull } from '../lib/llms';

// The whole site — summary, features, FAQ, every docs page — as one text file.
export const GET: APIRoute = async () =>
  new Response(await llmsFull(), { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
