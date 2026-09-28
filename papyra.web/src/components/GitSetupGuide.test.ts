import { describe, expect, it } from 'vitest';
import { normaliseRepoUrl, repoLabel } from '../lib/gitUrl';

describe('normaliseRepoUrl', () => {
  it('accepts whatever someone copies off GitHub', () => {
    const want = 'https://github.com/rahul/papyra-notes.git';
    expect(normaliseRepoUrl('https://github.com/rahul/papyra-notes')).toBe(want);
    expect(normaliseRepoUrl('https://github.com/rahul/papyra-notes.git')).toBe(want);
    expect(normaliseRepoUrl('https://github.com/rahul/papyra-notes/')).toBe(want);
    expect(normaliseRepoUrl('https://github.com/rahul/papyra-notes/tree/main')).toBe(want);
    expect(normaliseRepoUrl('github.com/rahul/papyra-notes')).toBe(want);
    expect(normaliseRepoUrl('git@github.com:rahul/papyra-notes.git')).toBe(want);
    expect(normaliseRepoUrl('rahul/papyra-notes')).toBe(want);
  });

  it('keeps other hosts as they are', () => {
    expect(normaliseRepoUrl('https://gitlab.com/group/sub/notes')).toBe('https://gitlab.com/group/sub/notes.git');
  });

  it('refuses things that are not a repository', () => {
    expect(normaliseRepoUrl('')).toBeNull();
    expect(normaliseRepoUrl('https://github.com/rahul')).toBeNull();
    expect(normaliseRepoUrl('not a url')).toBeNull();
    expect(normaliseRepoUrl('ftp://github.com/a/b')).toBeNull();
  });
});

describe('repoLabel', () => {
  it('names a GitHub repository by owner/name', () => {
    expect(repoLabel('https://github.com/rahul/papyra-notes.git')).toBe('rahul/papyra-notes');
    expect(repoLabel('https://gitlab.com/g/notes.git')).toBe('gitlab.com/g/notes');
  });
});
