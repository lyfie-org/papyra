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
