// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearCollabRoomCaches, forgetCollabRoomCache, rememberCollabRoomCache } from './collabCache';

describe('collab room caches', () => {
  const deleted: string[] = [];
  vi.stubGlobal('indexedDB', { deleteDatabase: (name: string) => { deleted.push(name); } });
  afterEach(() => { deleted.length = 0; localStorage.clear(); });

  it('drops the previous lineage when a room gets a new epoch', () => {
    rememberCollabRoomCache('1:n', 'papyra-collab:1:n:a');
    rememberCollabRoomCache('1:n', 'papyra-collab:1:n:a');
    expect(deleted).toEqual([]);
    rememberCollabRoomCache('1:n', 'papyra-collab:1:n:b');
    expect(deleted).toEqual(['papyra-collab:1:n:a']);
  });

  it('forgets a room whose access ended', () => {
    rememberCollabRoomCache('1:n', 'papyra-collab:1:n:a');
    forgetCollabRoomCache('1:n');
    forgetCollabRoomCache('1:n');
    expect(deleted).toEqual(['papyra-collab:1:n:a']);
  });

  it('clears every room on sign-out', () => {
    rememberCollabRoomCache('1:n', 'db1');
    rememberCollabRoomCache('2:m', 'db2');
    clearCollabRoomCaches();
    expect(deleted.sort()).toEqual(['db1', 'db2']);
    rememberCollabRoomCache('1:n', 'db3');
    expect(deleted).toHaveLength(2);
  });
});
