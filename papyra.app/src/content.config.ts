import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';

// The six things Papyra is. This collection is the single source for both the
// landing page's cards and the deep-dive pages, so the two cannot drift — the
// card copy lives in frontmatter, the long form is the body.
//
// Titles come from the app's own "How Papyra works" sheet
// (papyra.web/src/components/HelpSheet.tsx) wherever one exists, so the website
// and the product describe themselves in the same words.
const features = defineCollection({
  loader: glob({ base: './src/content/features', pattern: '**/*.mdx' }),
  schema: z.object({
    /** Heading, and the card title on the home page. */
    title: z.string(),
    /** One-sentence card body. Plain language, no jargon. */
    blurb: z.string(),
    /** Short capability names for the card's footer line. */
    points: z.array(z.string()).min(2).max(4),
    /** Position on the home page and in the features index. */
    order: z.number().int(),
    /** Sentence under the page heading. */
    lede: z.string(),
    /** Related docs page, linked at the foot of the deep dive. */
    docs: z.string().optional(),
  }),
});

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

export const collections = { features, docs };
