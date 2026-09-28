// Facts about this build and the project, in one place. The version is stamped
// at build time from the repo's VERSION file (vite.config.ts), so the sidebar
// and Settings → About always agree with the release — Settings used to carry
// its own hardcoded '0.0.1'.
export const APP_VERSION: string = import.meta.env.VITE_APP_VERSION ?? 'dev';
export const APP_VERSION_LABEL = APP_VERSION === 'dev' ? 'dev build' : `v${APP_VERSION}`;

export const GITHUB_URL = 'https://github.com/lyfie-org/papyra';
export const SITE_URL = 'https://papyra.app';
export const LICENSE = 'GNU GPL v3.0';
