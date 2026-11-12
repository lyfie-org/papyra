// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { downloadNote, noteFileBase } from './noteDownload';

describe('noteFileBase', () => {
  it('keeps a plain title and makes an awkward one safe', () => {
    expect(noteFileBase('Groceries')).toBe('Groceries');
    expect(noteFileBase('  a/b\\c:d*e?f"g<h>i|j  ')).toBe('a b c d e f g h i j');
    expect(noteFileBase('')).toBe('Untitled');
    expect(noteFileBase('///')).toBe('Untitled');
    expect(noteFileBase('x'.repeat(200))).toHaveLength(80);
  });
});

describe('downloadNote', () => {
  const saved: string[] = [];

  beforeEach(() => {
    saved.length = 0;
    URL.createObjectURL = vi.fn(() => 'blob:note');
    URL.revokeObjectURL = vi.fn();
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      saved.push(this.download);
    });
  });
  afterEach(() => vi.restoreAllMocks());

  const answer = (body: BodyInit, type: string, status = 200) =>
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(body, { status, headers: { 'Content-Type': type } }));

  it('saves plain text as .md', async () => {
    answer('---\n---\nhi', 'text/markdown; charset=utf-8');
    await downloadNote('/api/notes/n1/export', 'Trip / day 1');
    expect(saved).toEqual(['Trip day 1.md']);
  });

  it('saves a note with attachments as .zip — the server sent a zip, so the name follows', async () => {
    answer(new Uint8Array([0x50, 0x4b, 3, 4]), 'application/zip');
    await downloadNote('/api/notes/n1/export', 'Trip');
    expect(saved).toEqual(['Trip.zip']);
  });

  it('says what the server said when it refuses, and saves nothing', async () => {
    answer(JSON.stringify({ error: 'The owner locked this note.' }), 'application/json', 410);
    await expect(downloadNote('/api/shares/incoming/3/export', 'Locked')).rejects.toThrow('The owner locked this note.');
    expect(saved).toEqual([]);
  });

  it('explains an unreachable server', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('Failed to fetch'));
    await expect(downloadNote('/api/notes/n1/export', 'x')).rejects.toThrow(/unreachable/);
  });
});
