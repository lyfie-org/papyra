// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import ServiceTabs, { type ServiceTabItem } from './ServiceTabs';

const items: ServiceTabItem[] = ['ntfy', 'discord', 'telegram', 'network'].map(id => ({
  id, name: id, mark: null, chip: 'On', tone: 'on',
}));

// jsdom has no layout, so the row's widths are set by hand.
let widths: { client: number; scroll: number };
let scrollTo: ReturnType<typeof vi.fn>;

function mount(onChange = vi.fn()) {
  render(<ServiceTabs label="Services" items={items} value="ntfy" onChange={onChange}><p>panel</p></ServiceTabs>);
  return { onChange, list: screen.getByRole('tablist') };
}

const scrollList = (list: HTMLElement, left: number) => {
  list.scrollLeft = left;
  fireEvent.scroll(list);
};

beforeEach(() => {
  widths = { client: 400, scroll: 800 };
  scrollTo = vi.fn();
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(() => widths.client);
  vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockImplementation(() => widths.scroll);
  HTMLElement.prototype.scrollTo = scrollTo as unknown as typeof HTMLElement.prototype.scrollTo;
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('ServiceTabs arrows', () => {
  it('shows no arrow when every tile fits', () => {
    widths = { client: 800, scroll: 800 };
    mount();
    expect(screen.queryByRole('button', { name: 'Show more services' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Show earlier services' })).toBeNull();
  });

  it('shows an arrow only on the end that has more', () => {
    const { list } = mount();
    expect(screen.getByRole('button', { name: 'Show more services' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Show earlier services' })).toBeNull();

    scrollList(list, 200);
    expect(screen.getByRole('button', { name: 'Show more services' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Show earlier services' })).toBeTruthy();

    scrollList(list, 400);
    expect(screen.queryByRole('button', { name: 'Show more services' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Show earlier services' })).toBeTruthy();
  });

  it('scrolls the row without choosing a service', () => {
    const { list, onChange } = mount();
    scrollList(list, 100);
    fireEvent.click(screen.getByRole('button', { name: 'Show more services' }));
    expect(scrollTo).toHaveBeenLastCalledWith(expect.objectContaining({ left: 400 }));
    fireEvent.click(screen.getByRole('button', { name: 'Show earlier services' }));
    expect(scrollTo).toHaveBeenLastCalledWith(expect.objectContaining({ left: 0 }));
    expect(onChange).not.toHaveBeenCalled();
  });

  it('keeps the arrows out of the Tab order and out of the tablist', () => {
    const { list } = mount();
    const arrow = screen.getByRole('button', { name: 'Show more services' });
    expect(arrow.getAttribute('tabindex')).toBe('-1');
    expect(list.contains(arrow)).toBe(false);
  });
});
