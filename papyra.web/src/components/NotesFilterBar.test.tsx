// @vitest-environment jsdom
import { afterEach, describe, it, expect, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import NotesFilterBar, { type NotesScope } from './NotesFilterBar';

function renderBar(scope: NotesScope, hasShared: boolean) {
  const onScopeChange = vi.fn();
  render(
    <NotesFilterBar
      scope={scope}
      onScopeChange={onScopeChange}
      allTags={[]}
      selectedTags={[]}
      onSelectedTagsChange={() => {}}
      collections={[]}
      selectedCollection={null}
      onCollectionChange={() => {}}
      hasShared={hasShared}
    />,
  );
  return onScopeChange;
}

afterEach(cleanup);

describe('NotesFilterBar', () => {
  it('offers "Shared with me" next to Pinned once something is shared', () => {
    const onScopeChange = renderBar('all', true);
    const pills = screen.getAllByRole('button').map((b) => b.textContent?.trim());
    expect(pills.slice(0, 3)).toEqual(['All', 'Pinned', 'Shared with me']);
    fireEvent.click(screen.getByRole('button', { name: 'Shared with me' }));
    expect(onScopeChange).toHaveBeenCalledWith('shared');
  });

  it('hides the pill when nothing is shared', () => {
    renderBar('all', false);
    expect(screen.queryByRole('button', { name: 'Shared with me' })).toBeNull();
  });

  it('keeps the active pill visible even after the last share is revoked', () => {
    renderBar('shared', false);
    expect(screen.getByRole('button', { name: 'Shared with me' }).getAttribute('aria-pressed')).toBe('true');
  });
});
