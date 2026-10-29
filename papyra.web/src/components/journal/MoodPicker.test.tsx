// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import MoodPicker from './MoodPicker';
import type { Mood } from '../../types/journal';

afterEach(cleanup);

describe('MoodPicker', () => {
  it('is one labelled radio group of five named moods', () => {
    render(<MoodPicker value={null} onChange={() => {}} />);
    expect(screen.getByRole('radiogroup', { name: 'How the day felt' })).toBeTruthy();
    const names = screen.getAllByRole('radio').map((r) => r.getAttribute('aria-label'));
    expect(names).toEqual(['Rough', 'Low', 'Okay', 'Good', 'Great']);
  });

  it('says which one is chosen, to assistive tech as well as by sight', () => {
    render(<MoodPicker value={4} onChange={() => {}} />);
    const checked = screen.getAllByRole('radio').filter((r) => r.getAttribute('aria-checked') === 'true');
    expect(checked.map((r) => r.getAttribute('aria-label'))).toEqual(['Good']);
  });

  it('draws a different shape for each mood, so colour is never the only signal', () => {
    const { container } = render(<MoodPicker value={null} onChange={() => {}} />);
    const shapes = [...container.querySelectorAll('svg')].map((s) => s.innerHTML);
    expect(new Set(shapes).size).toBe(5);
    expect(container.querySelectorAll('svg[aria-hidden="true"]').length).toBe(5);
  });

  it('chooses on a tap and clears when the chosen one is tapped again', () => {
    const onChange = vi.fn();
    const { rerender } = render(<MoodPicker value={null} onChange={onChange} />);
    fireEvent.click(screen.getByRole('radio', { name: 'Okay' }));
    expect(onChange).toHaveBeenLastCalledWith(3);
    rerender(<MoodPicker value={3} onChange={onChange} />);
    fireEvent.click(screen.getByRole('radio', { name: 'Okay' }));
    expect(onChange).toHaveBeenLastCalledWith(null);
  });

  it('moves between the five with the arrow keys, wrapping at the ends', () => {
    const onChange = vi.fn();
    const { rerender } = render(<MoodPicker value={5} onChange={onChange} />);
    fireEvent.keyDown(screen.getByRole('radiogroup'), { key: 'ArrowRight' });
    expect(onChange).toHaveBeenLastCalledWith(1);
    rerender(<MoodPicker value={1} onChange={onChange} />);
    fireEvent.keyDown(screen.getByRole('radiogroup'), { key: 'ArrowLeft' });
    expect(onChange).toHaveBeenLastCalledWith(5);
    rerender(<MoodPicker value={null} onChange={onChange} />);
    fireEvent.keyDown(screen.getByRole('radiogroup'), { key: 'ArrowRight' });
    expect(onChange).toHaveBeenLastCalledWith(1);
  });

  it('does nothing while disabled', () => {
    const onChange = vi.fn();
    render(<MoodPicker value={null} onChange={onChange} disabled />);
    fireEvent.click(screen.getByRole('radio', { name: 'Great' }));
    fireEvent.keyDown(screen.getByRole('radiogroup'), { key: 'ArrowRight' });
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe('MoodPicker, collapsible', () => {
  it('shows the five, with a quiet prompt, until a mood is chosen', () => {
    render(<MoodPicker collapsible compact value={null} onChange={() => {}} />);
    expect(screen.getAllByRole('radio')).toHaveLength(5);
    expect(screen.getByText('How was the day?')).toBeTruthy();
  });

  it('folds a chosen mood into one chip that names it, and opens the five again on a tap', () => {
    const { rerender } = render(<MoodPicker collapsible compact value={null} onChange={() => {}} />);
    rerender(<MoodPicker collapsible compact value={4} onChange={() => {}} />);
    expect(screen.queryByRole('radiogroup')).toBeNull();
    const chip = screen.getByRole('button', { name: 'How the day felt: Good. Change' });
    expect(chip.getAttribute('aria-expanded')).toBe('false');
    expect(chip.textContent).toBe('Good');

    fireEvent.click(chip);
    const checked = screen.getAllByRole('radio').filter((r) => r.getAttribute('aria-checked') === 'true');
    expect(checked.map((r) => r.getAttribute('aria-label'))).toEqual(['Good']);
    expect(document.activeElement).toBe(checked[0]); // the keyboard lands on the chosen one
  });

  it('folds again once another is chosen, and hands the keyboard back to the chip', () => {
    const Harness = () => {
      const [v, setV] = useState<Mood | null>(4);
      return <MoodPicker collapsible compact value={v} onChange={setV} />;
    };
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: /Change/ }));
    fireEvent.click(screen.getByRole('radio', { name: 'Great' }));
    expect(screen.queryByRole('radiogroup')).toBeNull();
    const chip = screen.getByRole('button', { name: 'How the day felt: Great. Change' });
    expect(document.activeElement).toBe(chip);
  });

  it('Esc closes the five without changing anything', () => {
    const onChange = vi.fn();
    render(<MoodPicker collapsible compact value={2} onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: /Change/ }));
    fireEvent.keyDown(screen.getByRole('radiogroup'), { key: 'Escape' });
    expect(screen.queryByRole('radiogroup')).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('is not collapsible unless asked: a chosen mood still shows all five', () => {
    render(<MoodPicker value={3} onChange={() => {}} />);
    expect(screen.getAllByRole('radio')).toHaveLength(5);
  });
});
