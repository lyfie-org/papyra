import { afterEach, describe, expect, it, vi } from 'vitest';

// APP_VERSION is read from the build at import time, so each case stamps it first.
async function load(stamp: string | undefined) {
  vi.resetModules();
  if (stamp === undefined) vi.unstubAllEnvs(); else vi.stubEnv('VITE_APP_VERSION', stamp);
  return import('./serverVersion');
}

afterEach(() => vi.unstubAllEnvs());

describe('a build that is named exactly (the dev image)', () => {
  const DEV = '1.0.0-dev.abc1234';

  it('shows as that build, not as a release', async () => {
    const { versionLabel } = await load(DEV);
    expect(versionLabel(DEV)).toBe(`v${DEV}`);
    const { APP_VERSION_LABEL } = await import('./appInfo');
    expect(APP_VERSION_LABEL).toBe(`v${DEV}`);
  });

  it('is stale only against a different build, so a newer dev image asks for a reload', async () => {
    const { isStale } = await load(DEV);
    expect(isStale(DEV)).toBe(false);
    expect(isStale('1.0.0-dev.def5678')).toBe(true);
    expect(isStale('1.1.0')).toBe(true);
    expect(isStale(null)).toBe(false);
  });
});

describe('a release build and an unnamed local build', () => {
  it('a release is v1.2.3 and is stale against another version', async () => {
    const { isStale, versionLabel } = await load('1.2.3');
    expect(versionLabel('1.2.3')).toBe('v1.2.3');
    expect(isStale('1.2.3')).toBe(false);
    expect(isStale('1.2.4')).toBe(true);
  });

  it('a local dev server (no stamp) never calls itself stale', async () => {
    const { isStale, versionLabel } = await load('dev');
    expect(versionLabel('dev')).toBe('dev build');
    expect(isStale('1.2.3')).toBe(false);
  });
});
