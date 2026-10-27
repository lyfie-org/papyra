import { describe, expect, it } from 'vitest';
import { dayImages, newRefs, stripThumb } from './journalMedia';

describe('dayImages', () => {
  it('lists the pictures a day shows, once each, in order', () => {
    const md = 'Morning ![[beach.JPG]] and ![[ticket.pdf]]\n\n![alt](/api/media/dog.png) again ![[beach.jpg|300]]\n\n![[voice.weba]]';
    expect(dayImages(md)).toEqual(['beach.JPG', 'dog.png']);
  });

  it('is empty for no text or no pictures', () => {
    expect(dayImages(null)).toEqual([]);
    expect(dayImages('just words, and a [[link]]')).toEqual([]);
  });

  it('knows a phone’s formats', () => {
    expect(dayImages('![[a.heic]] ![[b.avif]] ![[c.webp]] ![[d.svg]]')).toEqual(['a.heic', 'b.avif', 'c.webp']);
  });
});

describe('newRefs', () => {
  it('finds the file an upload just became, whatever case the server kept', () => {
    expect(newRefs(['Beach.jpg'], '![[beach.jpg]] ![[voice-2026-10-24-0905.wav]]')).toEqual(['voice-2026-10-24-0905.wav']);
    expect(newRefs([], '')).toEqual([]);
  });
});

describe('stripThumb', () => {
  it('asks for a small resized copy and escapes the name', () => {
    expect(stripThumb('a b#1.png')).toBe('/api/media/a%20b%231.png/thumb?w=160');
  });
});
