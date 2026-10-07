import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';

// Documentation for someone running their own Papyra. Grouped so the sidebar has
// a shape; ordered within a group by `order`.
const docs = defineCollection({
  loader: glob({ base: './src/content/docs', pattern: '**/*.mdx' }),
  schema: z.object({
    title: z.string(),
    /** Sentence under the heading, and the meta description. */
    summary: z.string(),
    group: z.enum(['Getting started', 'Living with it', 'In depth', 'Reference']),
    order: z.number().int(),
  }),
});

export const collections = { docs };
