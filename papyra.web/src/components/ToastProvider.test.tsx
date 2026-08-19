// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import { ToastProvider } from './ToastProvider';
import { useToast } from '../lib/toastContext';

// A toast is what replaced nine `confirm()` calls on reversible actions, so what
// matters is the bargain it made: the thing already happened, the message says
// so, an Undo is reachable, it leaves by itself, and it never takes the caret
// away from whatever the person was doing.

function Trigger({ label, message, undo }: { label: string; message: string; undo?: () => void }) {
  const { toast } = useToast();
  return (
    <button type="button" onClick={() => toast(message, undo ? { label: 'Undo', onClick: undo } : undefined)}>
      {label}
    </button>
  );
}

function renderWithProvider(ui: React.ReactNode) {
  return render(<ToastProvider>{ui}</ToastProvider>);
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('ToastProvider', () => {
  it('says what just happened', () => {
    renderWithProvider(<Trigger label="delete" message="Note moved to Trash" />);
    expect(screen.queryByText('Note moved to Trash')).toBeNull();

    fireEvent.click(screen.getByText('delete'));
    expect(screen.getByText('Note moved to Trash')).toBeTruthy();
  });

  it('announces politely instead of stealing focus', () => {
    renderWithProvider(<Trigger label="delete" message="Note moved to Trash" />);
    const button = screen.getByText('delete');
    button.focus();
    fireEvent.click(button);

    const live = screen.getByRole('status');
    expect(live.getAttribute('aria-live')).toBe('polite');
    // The whole point of aria-live over a dialog: the cursor stays where the
    // person was working.
    expect(document.activeElement).toBe(button);
  });

  it('offers an undo, runs it, and takes the toast away with it', () => {
    const undo = vi.fn();
    renderWithProvider(<Trigger label="delete" message="Note moved to Trash" undo={undo} />);
    fireEvent.click(screen.getByText('delete'));

    fireEvent.click(screen.getByText('Undo'));
    expect(undo).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('Note moved to Trash')).toBeNull();
  });

  it('has no action button when there is nothing to undo', () => {
    renderWithProvider(<Trigger label="save" message="Saved" />);
    fireEvent.click(screen.getByText('save'));
    expect(screen.queryByText('Undo')).toBeNull();
  });

  it('can be dismissed by hand', () => {
    renderWithProvider(<Trigger label="save" message="Saved" />);
    fireEvent.click(screen.getByText('save'));

    fireEvent.click(screen.getByLabelText('Dismiss'));
    expect(screen.queryByText('Saved')).toBeNull();
  });

  it('leaves by itself after five seconds', () => {
    vi.useFakeTimers();
    renderWithProvider(<Trigger label="save" message="Saved" />);
    fireEvent.click(screen.getByText('save'));

    act(() => { vi.advanceTimersByTime(4999); });
    expect(screen.getByText('Saved')).toBeTruthy();

    act(() => { vi.advanceTimersByTime(1); });
    expect(screen.queryByText('Saved')).toBeNull();
  });

  it('stacks, and dismissing one leaves the others alone', () => {
    renderWithProvider(
      <>
        <Trigger label="first" message="Note moved to Trash" />
        <Trigger label="second" message="Category deleted" />
      </>,
    );
    fireEvent.click(screen.getByText('first'));
    fireEvent.click(screen.getByText('second'));
    expect(screen.getAllByLabelText('Dismiss')).toHaveLength(2);

    fireEvent.click(screen.getAllByLabelText('Dismiss')[0]);
    expect(screen.queryByText('Note moved to Trash')).toBeNull();
    expect(screen.getByText('Category deleted')).toBeTruthy();
  });

  it('gives each toast its own expiry rather than one shared timer', () => {
    vi.useFakeTimers();
    renderWithProvider(
      <>
        <Trigger label="first" message="Note moved to Trash" />
        <Trigger label="second" message="Category deleted" />
      </>,
    );
    fireEvent.click(screen.getByText('first'));
    act(() => { vi.advanceTimersByTime(3000); });
    fireEvent.click(screen.getByText('second'));

    // 5s after the first, 2s after the second: the older one goes, the newer stays.
    act(() => { vi.advanceTimersByTime(2000); });
    expect(screen.queryByText('Note moved to Trash')).toBeNull();
    expect(screen.getByText('Category deleted')).toBeTruthy();

    act(() => { vi.advanceTimersByTime(3000); });
    expect(screen.queryByText('Category deleted')).toBeNull();
  });

  it('is a no-op outside the provider, not a crash', () => {
    // A component that happens to mention a toast should still render in a test
    // or an isolated view that never mounted the provider.
    expect(() => {
      render(<Trigger label="save" message="Saved" />);
      fireEvent.click(screen.getByText('save'));
    }).not.toThrow();
    expect(screen.queryByText('Saved')).toBeNull();
  });
});
