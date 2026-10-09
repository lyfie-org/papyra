// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useRef } from 'react';
import NoteToc from './NoteToc';

// The outline rail is one control (WCAG 2.5.8: its rows are far under 24px on
// their own): one tab stop, arrow keys pick a heading, Enter jumps to it.

afterEach(cleanup);

function Note() {
  const ref = useRef<HTMLDivElement | null>(null);
  return (
    <div ref={ref}>
      <div className="luthor-content-editable">
        <h1>Intro</h1><p>a</p><h2>Method</h2><p>b</p><h2>Results</h2>
      </div>
      <NoteToc scrollRef={ref} />
    </div>
  );
}

describe('NoteToc', () => {
  it('is a single listbox of the headings, with no buttons of its own', () => {
    render(<Note />);
    const rail = screen.getByRole('listbox', { name: 'Jump to a heading' });
    expect(rail.getAttribute('tabindex')).toBe('0');
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['Intro', 'Method', 'Results']);
    expect(screen.queryAllByRole('button')).toEqual([]);
  });

  it('walks the headings with the arrow keys and jumps with Enter', () => {
    render(<Note />);
    const rail = screen.getByRole('listbox');
    const scroller = rail.closest('nav')!.parentElement!;
    scroller.scrollTo = vi.fn();
    act(() => rail.focus());
    // It starts on the section being read.
    const current = screen.getAllByRole('option').find((o) => o.getAttribute('aria-current') === 'location')!;
    expect(rail.getAttribute('aria-activedescendant')).toBe(current.id);
    fireEvent.keyDown(rail, { key: 'Home' });
    fireEvent.keyDown(rail, { key: 'ArrowDown' });
    const second = screen.getAllByRole('option')[1];
    expect(rail.getAttribute('aria-activedescendant')).toBe(second.id);
    expect(second.getAttribute('aria-selected')).toBe('true');
    fireEvent.keyDown(rail, { key: 'Enter' });
    expect(scroller.scrollTo).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(rail, { key: 'Escape' });
    expect(rail.getAttribute('aria-activedescendant')).toBeNull();
  });
});
