// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useRef } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useDismiss } from './useDismiss';

function Popover({ open, onClose }: { open: boolean; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(ref, open, onClose);
  return (
    <>
      <div ref={ref}><button type="button">inside</button></div>
      <button type="button">outside</button>
    </>
  );
}

afterEach(cleanup);

describe('useDismiss', () => {
  it('closes on a press outside, not inside', () => {
    const onClose = vi.fn();
    render(<Popover open onClose={onClose} />);
    fireEvent.pointerDown(screen.getByText('inside'));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.pointerDown(screen.getByText('outside'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes on Escape and claims the key', () => {
    const onClose = vi.fn();
    render(<Popover open onClose={onClose} />);
    const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    document.dispatchEvent(event);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
  });

  it('does nothing while closed', () => {
    const onClose = vi.fn();
    render(<Popover open={false} onClose={onClose} />);
    fireEvent.pointerDown(screen.getByText('outside'));
    expect(onClose).not.toHaveBeenCalled();
  });
});
