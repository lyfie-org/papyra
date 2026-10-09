import { describe, expect, it, vi } from 'vitest';
import { resolveCard, resolveEmbed, toEmbedResolution } from './embedResolve';

const base = { url: 'https://x.test/a', finalUrl: 'https://x.test/a', frameable: true };

describe('toEmbedResolution', () => {
  it('embeds a short link through the service it lands on', () => {
    const r = toEmbedResolution({
      ...base,
      url: 'https://maps.app.goo.gl/abc',
      finalUrl: 'https://www.google.com/maps/place/Nikkawahama+Beach/@35.84,140.8,15z',
      frameable: false,
    });
    expect(r.type).toBe('iframe');
    if (r.type !== 'iframe') return;
    const src = new URL(r.src);
    expect(src.searchParams.get('q')).toBe('Nikkawahama Beach');
    expect(src.searchParams.get('output')).toBe('embed');
  });

  it("sees through a consent page to where the short link was going", () => {
    const r = toEmbedResolution({
      ...base,
      url: 'https://maps.app.goo.gl/abc',
      finalUrl: `https://consent.google.com/m?continue=${encodeURIComponent('https://www.google.com/maps/place/Big+Ben/@51.5,-0.12,17z')}&gl=DE`,
      frameable: false,
    });
    expect(r.type === 'iframe' && new URL(r.src).searchParams.get('q')).toBe('Big Ben');
  });

  it("uses the page's own oEmbed player and size", () => {
    expect(toEmbedResolution({ ...base, embedSrc: 'https://x.test/player/1', width: 800, height: 450, title: 'Talk' }))
      .toEqual({ type: 'iframe', src: 'https://x.test/player/1', width: 800, height: 450, title: 'Talk' });
  });

  it('frames a page that allows it', () => {
    expect(toEmbedResolution({ ...base, finalUrl: 'https://x.test/b', title: 'B' }))
      .toEqual({ type: 'iframe', src: 'https://x.test/b', title: 'B' });
  });

  it("puts a link card in place of a page that refuses framing", () => {
    expect(toEmbedResolution({ ...base, frameable: false, title: 'News' }))
      .toEqual({ type: 'card', url: 'https://x.test/a', title: 'News' });
  });
});

describe('resolveEmbed', () => {
  it('asks the server, and keeps the link as given when it can’t', async () => {
    const ok = vi.fn(async () => Response.json({ ...base }));
    expect(await resolveEmbed('https://x.test/a', ok)).toEqual({ type: 'iframe', src: 'https://x.test/a', title: undefined });
    expect(ok).toHaveBeenCalledWith('/api/embed/resolve?url=https%3A%2F%2Fx.test%2Fa', expect.anything());
    expect(await resolveEmbed('https://x.test/a', vi.fn(async () => new Response(null, { status: 204 })))).toBeNull();
    expect(await resolveEmbed('https://x.test/a', vi.fn(async () => { throw new TypeError('offline'); }))).toBeNull();
  });
});

describe('resolveCard', () => {
  it("maps the server's link preview onto a card", async () => {
    const fetcher = vi.fn(async () => Response.json({
      url: 'https://x.test/a', title: 'A', description: 'About A', image: 'https://x.test/a.png', siteName: 'X', icon: 'https://x.test/i.png',
    }));
    expect(await resolveCard('https://x.test/a', fetcher)).toEqual({
      title: 'A', description: 'About A', image: 'https://x.test/a.png', favicon: 'https://x.test/i.png', siteName: 'X',
    });
  });
});
