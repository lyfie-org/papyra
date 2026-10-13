// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import BusyButton from './BusyButton';
import { DOCK_SHOW_AFTER_MS, stepCards, type Card } from '../lib/activityCards';
import { beginTask, getActivity, track } from '../lib/progress';

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('BusyButton', () => {
  it('says it is working while its click runs, and ignores clicks meanwhile', async () => {
    let finish!: () => void;
    const onClick = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    const { getByRole } = render(<BusyButton onClick={onClick} busyLabel="Creating…">Create key</BusyButton>);
    const button = getByRole('button');

    fireEvent.click(button);
    expect(button.getAttribute('aria-busy')).toBe('true');
    expect(button.textContent).toBe('Create key'); // a quick action never flashes a spinner
    act(() => { vi.advanceTimersByTime(150); });
    expect(button.textContent).toBe('Creating…');
    expect(button.querySelector('.busy-btn__bar')).not.toBeNull();

    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);

    await act(async () => { finish(); });
    act(() => { vi.advanceTimersByTime(500); });
    expect(button.getAttribute('aria-busy')).toBeNull();
    expect(button.textContent).toBe('Create key');
  });

  it('blocks a busy submit button from submitting the form again', () => {
    const onSubmit = vi.fn((e: { preventDefault(): void }) => e.preventDefault());
    const { getByRole } = render(<form onSubmit={onSubmit}><BusyButton type="submit" busy>Save</BusyButton></form>);
    fireEvent.click(getByRole('button'));
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('fills its bar from real progress', () => {
    const { getByRole } = render(<BusyButton busy progress={0.4}>Download</BusyButton>);
    act(() => { vi.advanceTimersByTime(150); });
    const bar = getByRole('button').querySelector<HTMLElement>('.busy-btn__bar--known')!;
    expect(bar.style.getPropertyValue('--busy-frac')).toBe('0.4');
  });
});

describe('activity dock cards', () => {
  it('only names work that lasts, keeps it readable, then lets it go', () => {
    const task = { id: 1, label: 'Backing up', progress: null, startedAt: 0 };
    let cards: Card[] = stepCards([], [task], 100);
    expect(cards).toHaveLength(0); // too soon: the button already said so
    cards = stepCards(cards, [task], DOCK_SHOW_AFTER_MS);
    expect(cards).toMatchObject([{ label: 'Backing up', endedAt: null }]);
    expect(stepCards(cards, [task], DOCK_SHOW_AFTER_MS + 10)).toBe(cards); // unchanged → same array

    cards = stepCards(cards, [], DOCK_SHOW_AFTER_MS + 100); // ended
    expect(cards[0]!.endedAt).toBe(DOCK_SHOW_AFTER_MS + 100);
    expect(stepCards(cards, [], DOCK_SHOW_AFTER_MS + 500)).toHaveLength(1); // still within its minimum
    expect(stepCards(cards, [], DOCK_SHOW_AFTER_MS + 5000)).toHaveLength(0);
  });

  it('lists labelled tasks from track() and beginTask()', async () => {
    let finish!: () => void;
    const work = track(new Promise<void>((resolve) => { finish = resolve; }), 'Restoring');
    const plain = beginTask();
    const named = beginTask();
    named.label('Importing 3/9');
    expect(getActivity().labelled.map((t) => t.label)).toEqual(['Restoring', 'Importing 3/9']);
    finish();
    await work;
    plain.end();
    named.end();
    expect(getActivity().labelled).toEqual([]);
  });
});
