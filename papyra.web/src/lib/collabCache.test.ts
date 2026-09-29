// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  clearCollabRoomCaches,
  findCollabRoomCache,
  forgetCollabRoomCache,
  rememberCollabRoomCache,
  type CachedCollabRoom,
} from './collabCache';

const entry = (db: string, target = '{"noteId":"n"}'): CachedCollabRoom => ({
  db, target, epoch: 'e', uid: 1, username: 'owner', name: 'Owner', url: '/collab',
});

describe('collab room caches', () => {
  const deleted: string[] = [];
  vi.stubGlobal('indexedDB', { deleteDatabase: (name: string) => { deleted.push(name); } });
  afterEach(() => { deleted.length = 0; localStorage.clear(); });

  it('drops the previous lineage when a room gets a new epoch', () => {
    rememberCollabRoomCache('1:n', entry('papyra-collab:1:n:a'));
    rememberCollabRoomCache('1:n', entry('papyra-collab:1:n:a'));
    expect(deleted).toEqual([]);
    rememberCollabRoomCache('1:n', entry('papyra-collab:1:n:b'));
    expect(deleted).toEqual(['papyra-collab:1:n:a']);
  });

  it('forgets a room whose access ended', () => {
    rememberCollabRoomCache('1:n', entry('papyra-collab:1:n:a'));
    forgetCollabRoomCache('1:n');
    forgetCollabRoomCache('1:n');
    expect(deleted).toEqual(['papyra-collab:1:n:a']);
    expect(findCollabRoomCache('{"noteId":"n"}')).toBeNull();
  });

  it('clears every room on sign-out', () => {
    rememberCollabRoomCache('1:n', entry('db1'));
    rememberCollabRoomCache('2:m', entry('db2', '{"shareId":4}'));
    clearCollabRoomCaches();
    expect(deleted.sort()).toEqual(['db1', 'db2']);
    rememberCollabRoomCache('1:n', entry('db3'));
    expect(deleted).toHaveLength(2);
  });

  it('finds the offline copy for a note or share', () => {
    rememberCollabRoomCache('1:n', entry('db1'));
    rememberCollabRoomCache('2:m', entry('db2', '{"shareId":4}'));
    expect(findCollabRoomCache('{"shareId":4}')).toEqual({ room: '2:m', cache: entry('db2', '{"shareId":4}') });
    expect(findCollabRoomCache('{"noteId":"n"}')?.room).toBe('1:n');
    expect(findCollabRoomCache('{"noteId":"x"}')).toBeNull();
  });

  it('still deletes, but never reopens, entries from before offline open', () => {
    localStorage.setItem('papyra-collab-dbs', JSON.stringify({ '1:n': 'legacy-db' }));
    expect(findCollabRoomCache('{"noteId":"n"}')).toBeNull();
    rememberCollabRoomCache('1:n', entry('db-new'));
    expect(deleted).toEqual(['legacy-db']);
  });
});
