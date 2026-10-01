// @vitest-environment node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { embedTarget, extractMediaRefs } from '../src/lib/mediaRefs';

// The API's MediaRefParser runs the same cases: if the two ever disagree, a
// card shows a picture the share link then refuses (or the other way round).
interface Case { name: string; body: string; refs: string[]; not?: string[] }
const fixture = JSON.parse(
  readFileSync(resolve(__dirname, '../../papyra.api/tests/fixtures/media-refs.json'), 'utf8'),
) as { cases: Case[] };

const lower = (xs: string[]) => xs.map((x) => x.toLowerCase()).sort();

describe('extractMediaRefs (shared fixture)', () => {
  it.each(fixture.cases.map((c) => [c.name, c] as const))('%s', (_, c) => {
    const refs = extractMediaRefs(c.body);
    expect(lower(refs)).toEqual(lower(c.refs));
    for (const n of c.not ?? []) expect(lower(refs)).not.toContain(n.toLowerCase());
  });
});

describe('extractMediaRefs', () => {
  it('keeps order of appearance and the first spelling', () => {
    expect(extractMediaRefs('![[B.png]] ![[a.png]] ![[b.PNG]]')).toEqual(['B.png', 'a.png']);
  });

  it('is empty for nothing', () => {
    expect(extractMediaRefs('')).toEqual([]);
    expect(extractMediaRefs(null)).toEqual([]);
  });
});

describe('embedTarget', () => {
  it.each([
    ['a.png', 'a.png'],
    ['a.png|480', 'a.png'],
    ['a.png|Alt|640x360', 'a.png'],
    ['doc.pdf#page=3', 'doc.pdf'],
    ['scan.png^abc', 'scan.png'],
    ['table.png\\|200', 'table.png'],
    [' spaced.png ', 'spaced.png'],
  ])('%s → %s', (inner, want) => {
    expect(embedTarget(inner)).toBe(want);
  });
});

describe('extractMediaRefs on hostile input', () => {
  // Same pieces the API's MediaFuzzTests uses: every save and card render runs this.
  const pieces = ['![[', '[[', ']]', '|', '\\|', '#', '^', '#page=3', '|300', '![', '](', ')', '<', '>', '/api/media/',
    '/api/shared/tok/media/', 'photo.png', 'a b.jpg', 'sub/', '..', '../', '%20', '%', '%zz', 'youtube:', 'https://',
    '<img src="', '"', "'", ' ', '\n', '\t', '\u0000', 'é', '😀', '\u202e', '[', ']', '(', '!'];
  let seed = 20261001;
  const random = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };

  it('never throws, and yields only bare, bounded names (20 000 random bodies)', () => {
    const started = performance.now();
    for (let i = 0; i < 20_000; i++) {
      let body = '';
      const n = Math.floor(random() * 40);
      for (let k = 0; k < n; k++) {
        body += random() < 0.25 ? String.fromCharCode(Math.floor(random() * 0x3000)) : pieces[Math.floor(random() * pieces.length)];
      }
      for (const name of extractMediaRefs(body)) {
        expect(name.length).toBeGreaterThan(0);
        expect(name.length).toBeLessThanOrEqual(255);
        expect(name).not.toMatch(/[/\\]/);
        expect(['.', '..']).not.toContain(name);
      }
    }
    // No pathological backtracking: a card desk runs this per note.
    expect(performance.now() - started).toBeLessThan(5000);
  });

  it('stays linear on a huge body', () => {
    const body = '![[a.png|300]] text '.repeat(20_000) + '[['.repeat(20_000) + '](' .repeat(20_000);
    const started = performance.now();
    expect(extractMediaRefs(body)).toEqual(['a.png']);
    expect(performance.now() - started).toBeLessThan(2000);
  });
});
