import { describe, expect, it } from 'vitest';
import { routePattern } from './clientLog';

describe('routePattern', () => {
  it('keeps the screen and drops what is on it', () => {
    expect(routePattern('/')).toBe('/');
    expect(routePattern('/settings')).toBe('/settings');
    expect(routePattern('/note/My%20Diary')).toBe('/note/:id');
    expect(routePattern('/shared/abc123token')).toBe('/shared/:id');
  });

  it('never repeats a path it does not recognise', () => {
    expect(routePattern('/alice/secret-plans')).toBe('/:page/:id');
  });
});
