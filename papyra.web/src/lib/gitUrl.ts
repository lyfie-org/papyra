/**
 * Turn whatever someone copied off GitHub into the https address git needs:
 * the browser address, the "Code" button's https or SSH form, or a bare
 * `you/papyra-notes`. Null when it isn't recognisably a repository.
 */
export function normaliseRepoUrl(input: string): string | null {
  let v = input.trim().replace(/\/+$/, '');
  if (!v) return null;
  const ssh = /^git@github\.com:(.+)$/.exec(v);
  if (ssh) v = `https://github.com/${ssh[1]}`;
  if (/^[\w.-]+\/[\w.-]+$/.test(v)) v = `https://github.com/${v}`;
  if (/^github\.com\//i.test(v)) v = `https://${v}`;
  let url: URL;
  try { url = new URL(v); } catch { return null; }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  const parts = url.pathname.split('/').filter(Boolean);
  if (parts.length < 2) return null;
  // A GitHub page inside the repo (…/tree/main) still names the repo first.
  const path = url.hostname.toLowerCase() === 'github.com' ? parts.slice(0, 2) : parts;
  const joined = path.join('/').replace(/\.git$/, '');
  return `${url.protocol}//${url.host}/${joined}.git`;
}

/** "you/papyra-notes" for a GitHub address, the host + path otherwise. */
export function repoLabel(remoteUrl: string): string {
  try {
    const url = new URL(remoteUrl);
    const path = url.pathname.replace(/^\/|\.git$/g, '');
    return url.hostname === 'github.com' ? path : `${url.hostname}/${path}`;
  } catch {
    return remoteUrl;
  }
}
