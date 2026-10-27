// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import MoodPicker from './MoodPicker';

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
