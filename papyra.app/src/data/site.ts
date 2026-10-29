// Facts about the project, in one place. Everything here is verified against the
// repository — the remote in .git/config, the image name in docker-compose.hub.yml,
// the licence file — rather than assumed.

export const GITHUB_URL = 'https://github.com/lyfie-org/papyra';
export const DOCKER_HUB_URL = 'https://hub.docker.com/r/lyfie/papyra';
/** The lyfie.org community Discord (Papyra has its own channels there). Never-expiring invite. */
export const DISCORD_URL = 'https://discord.gg/KQNsjGAUUz';
/**
 * Which line this build is: the production site (papyra.app, from main) or the
 * dev preview (dev.papyra.app, from development). Set by .github/workflows/site.yml;
 * unset locally, so a plain `pnpm run build` is always production.
 */
export const IS_DEV_SITE = import.meta.env.PUBLIC_SITE_CHANNEL === 'dev';

/** The dev preview tracks the dev image, published by .github/workflows/docker-dev.yml. */
export const DOCKER_IMAGE = IS_DEV_SITE ? 'lyfie/papyra:dev' : 'lyfie/papyra:latest';
export const LICENSE = 'GNU GPL v3.0';

/** The one-line description used in the manifest and the app's About tab. */
export const TAGLINE = 'A calm, self-hosted home for your notes.';

export const NAV = [
  { href: '/#features', label: 'Features' },
  { href: '/#journey', label: 'Roadmap' },
  { href: '/docs/', label: 'Docs' },
  { href: '/contribute/', label: 'Contribute' },
] as const;

/** Papyra is a Lyfie project — the open-source organisation behind it and luthor. */
export const LYFIE_URL = 'https://www.lyfie.org';
export const LYFIE_PROJECT_URL = 'https://www.lyfie.org/projects/papyra/';
export const LUTHOR_URL = 'https://www.luthor.fyi';
export const CREATOR_NAME = 'Rahul N. Anand';
export const CREATOR_URL = 'https://www.rahulnsanand.com';

/** Always production — the dev preview's canonicals point here too, so it never competes. */
export const SITE_URL = 'https://papyra.app';

/** One description, used by meta tags, structured data and llms.txt. */
export const DESCRIPTION =
  'Papyra is a free, open-source, self-hosted note-taking app — a private Google Keep alternative. Every note is a plain Markdown file on your own server. No tracking; one daily update check.';
