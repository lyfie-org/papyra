// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import SectionToggle from './SectionToggle';
import VaultSection from './VaultSection';

afterEach(() => { cleanup(); localStorage.clear(); });

describe('SectionToggle', () => {
  it('says what it folds, how many, and whether it is showing', () => {
    const onToggle = vi.fn();
    render(<SectionToggle label="Pinned" count={3} open onToggle={onToggle} controls="body" />);
    const button = screen.getByRole('button', { name: /Pinned/ });
    expect(button.getAttribute('aria-expanded')).toBe('true');
    expect(button.getAttribute('aria-controls')).toBe('body');
    expect(button.textContent).toContain('3');
    fireEvent.click(button);
    expect(onToggle).toHaveBeenCalledOnce();
  });

  it('does not point at a body that is not there while folded', () => {
    render(<SectionToggle label="Others" open={false} onToggle={() => {}} controls="body" />);
    const button = screen.getByRole('button', { name: /Others/ });
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(button.hasAttribute('aria-controls')).toBe(false);
  });
});

describe('VaultSection', () => {
  it('folds its contents away and remembers it', () => {
    const section = <VaultSection name="journal" label="Journal" count={2}><p>two locked days</p></VaultSection>;
    const { unmount } = render(section);
    expect(screen.queryByText('two locked days')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Journal/ }));
    expect(screen.queryByText('two locked days')).toBeNull();
    unmount();
    render(section);
    expect(screen.queryByText('two locked days')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Journal/ }));
    expect(screen.queryByText('two locked days')).toBeTruthy();
  });
});
