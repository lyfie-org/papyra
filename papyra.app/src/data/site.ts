// Facts about the project, in one place. Everything here is verified against the
// repository — the remote in .git/config, the image name in docker-compose.hub.yml,
// the licence file — rather than assumed.

export const GITHUB_URL = 'https://github.com/lyfie-org/papyra';
export const DOCKER_HUB_URL = 'https://hub.docker.com/r/lyfie/papyra';
export const DOCKER_IMAGE = 'lyfie/papyra:latest';
export const LICENSE = 'GNU GPL v3.0';

/** The one-line description used in the manifest and the app's About tab. */
export const TAGLINE = 'A calm, self-hosted home for your notes.';

export const NAV = [
  { href: '/features/', label: 'Features' },
  { href: '/docs/', label: 'Docs' },
  { href: '/api/', label: 'API' },
  { href: '/demo/', label: 'Demo' },
] as const;
