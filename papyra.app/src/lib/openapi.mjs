// Turn Papyra's OpenAPI document into something renderable at build time.
//
// The reference is rendered statically rather than mounted as an interactive
// console. A console would be inert here: the API needs a Papyra server and a
// personal access token, and there is no public instance for this site to point
// at. Every self-hosted instance already serves a live, interactive portal at
// /docs, which is where trying a request actually works — so this page's job is
// to be readable and linkable, not to make requests.

import spec from '../data/openapi.json';

/**
 * Endpoints registered without an explicit .WithTags(...) inherit the assembly
 * name, so the document contains a tag literally called "Papyra.Api" holding
 * search, chat, media, shared links and the system jobs. Grouping by path here
 * is presentation only — the fix belongs in Program.cs, but a public reference
 * should not have a group named after a .NET assembly.
 */
const FALLBACK_TAG = 'Papyra.Api';

const BY_PREFIX = [
  ['/api/search', 'Search'],
  ['/api/ai', 'AI'],
  ['/api/media', 'Media'],
  ['/api/system', 'Admin'],
  ['/api/shared', 'Sharing'],
  ['/api/import', 'Import & export'],
  ['/api/export', 'Import & export'],
];

/** Order groups the way someone learning the API should meet them. */
const GROUP_ORDER = [
  'Auth',
  'Notes',
  'Search',
  'AI',
  'Categories',
  'Collections',
  'Sharing',
  'Inbox',
  'Media',
  'Import & export',
  'Backups',
  'Git',
  'Webhooks',
  'Settings',
  'Conflicts',
  'API Keys',
  'Directory',
  'WebAuthn',
  'Admin',
  'System',
];

const tagFor = (path, tags) => {
  const named = (tags ?? []).find((t) => t !== FALLBACK_TAG);
  if (named) return named;
  const match = BY_PREFIX.find(([prefix]) => path.startsWith(prefix));
  return match ? match[1] : 'Other';
};

/** Resolve a local $ref one level — enough to list a request body's fields. */
function resolve(schema) {
  if (!schema) return null;
  if (schema.$ref) {
    const name = schema.$ref.replace('#/components/schemas/', '');
    const target = spec.components?.schemas?.[name];
    return target ? { name, ...target } : { name };
  }
  return schema;
}

/** A short, human type label for a schema node. */
export function typeLabel(schema) {
  if (!schema) return 'any';
  if (schema.$ref) return schema.$ref.replace('#/components/schemas/', '');

  // A nullable field is emitted as type: ["array", "null"], so check membership
  // rather than equality — otherwise every nullable list reads as a bare
  // "array" and loses its element type.
  const types = Array.isArray(schema.type) ? schema.type.filter((t) => t !== 'null') : [schema.type];

  if (types.includes('array')) return `${typeLabel(schema.items)}[]`;
  if (schema.format === 'date-time') return 'date-time';
  return types.filter(Boolean).join(' | ') || 'object';
}

const METHOD_ORDER = ['get', 'post', 'put', 'patch', 'delete'];

export function buildReference() {
  const operations = [];

  for (const [path, methods] of Object.entries(spec.paths)) {
    for (const [method, op] of Object.entries(methods)) {
      if (!METHOD_ORDER.includes(method)) continue;

      const body = resolve(op.requestBody?.content?.['application/json']?.schema);
      const bodyFields = body?.properties
        ? Object.entries(body.properties).map(([name, prop]) => ({
            name,
            type: typeLabel(prop),
            required: (body.required ?? []).includes(name),
          }))
        : [];

      operations.push({
        id: `${method}-${path}`.replace(/[^a-z0-9]+/gi, '-').toLowerCase().replace(/^-|-$/g, ''),
        method: method.toUpperCase(),
        path,
        group: tagFor(path, op.tags),
        summary: op.summary ?? null,
        description: op.description ?? null,
        // The only anonymous surface is a tokenised share link; everything else
        // needs a session cookie or a personal access token.
        anonymous: path.startsWith('/api/shared/'),
        admin: /\(admin\)/i.test(op.summary ?? ''),
        params: (op.parameters ?? []).map((p) => ({
          name: p.name,
          in: p.in,
          required: Boolean(p.required),
          type: typeLabel(p.schema),
        })),
        bodyName: body?.name ?? null,
        bodyFields,
        responses: Object.keys(op.responses ?? {}),
      });
    }
  }

  const groups = new Map();
  for (const op of operations) {
    if (!groups.has(op.group)) groups.set(op.group, []);
    groups.get(op.group).push(op);
  }

  const ordered = [...groups.entries()]
    .sort((a, b) => {
      const ai = GROUP_ORDER.indexOf(a[0]);
      const bi = GROUP_ORDER.indexOf(b[0]);
      return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
    })
    .map(([name, ops]) => ({
      name,
      operations: ops.sort(
        (a, b) =>
          a.path.localeCompare(b.path) ||
          METHOD_ORDER.indexOf(a.method.toLowerCase()) -
            METHOD_ORDER.indexOf(b.method.toLowerCase()),
      ),
    }));

  return {
    title: spec.info?.title ?? 'Papyra API',
    version: spec.openapi,
    groups: ordered,
    operationCount: operations.length,
    pathCount: Object.keys(spec.paths).length,
    documented: operations.filter((o) => o.summary).length,
  };
}
