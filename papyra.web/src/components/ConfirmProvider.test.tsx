// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { ConfirmProvider } from './ConfirmProvider';
import { useConfirm } from '../lib/confirmContext';
import type { ConfirmRequest } from '../lib/confirmContext';

// This is the last thing standing between a person and something they cannot get
// back, so the tests are about the answer it returns and how easy it is to say
// no: every way out resolves false, focus starts on the escape route, and the
// default outside the provider is a refusal.

const destructiveRequest: ConfirmRequest = {
  title: 'Delete this note for good?',
  body: 'This note is not in Trash. Deleting it here cannot be undone.',
  confirmLabel: 'Delete for good',
  destructive: true,
};

function Trigger({ request = destructiveRequest, onResult }: {
  request?: ConfirmRequest;
  onResult: (ok: boolean) => void;
}) {
  const confirm = useConfirm();
  return (
    <button type="button" onClick={async () => { onResult(await confirm(request)); }}>
      ask
    </button>
  );
}

function open(onResult: (ok: boolean) => void, request?: ConfirmRequest) {
  render(<ConfirmProvider><Trigger request={request} onResult={onResult} /></ConfirmProvider>);
  fireEvent.click(screen.getByText('ask'));
}

afterEach(cleanup);

describe('ConfirmProvider', () => {
  it('asks in Papyra\'s own words, naming the action rather than saying OK', () => {
    open(vi.fn());
    expect(screen.getByText('Delete this note for good?')).toBeTruthy();
    expect(screen.getByText('This note is not in Trash. Deleting it here cannot be undone.')).toBeTruthy();
    expect(screen.getByText('Delete for good')).toBeTruthy();
    expect(screen.getByText('Cancel')).toBeTruthy();
  });

  it('resolves true only when the named action is pressed', async () => {
    const onResult = vi.fn();
    open(onResult);
    fireEvent.click(screen.getByText('Delete for good'));
    await waitFor(() => expect(onResult).toHaveBeenCalledWith(true));
  });

  it('resolves false when cancelled', async () => {
    const onResult = vi.fn();
    open(onResult);
    fireEvent.click(screen.getByText('Cancel'));
    await waitFor(() => expect(onResult).toHaveBeenCalledWith(false));
  });

  it('resolves false on Escape', async () => {
    const onResult = vi.fn();
    open(onResult);
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(onResult).toHaveBeenCalledWith(false));
  });

  it('resolves false when the backdrop is clicked', async () => {
    const onResult = vi.fn();
    open(onResult);
    const dialog = screen.getByRole('alertdialog');
    fireEvent.mouseDown(dialog.parentElement!);
    await waitFor(() => expect(onResult).toHaveBeenCalledWith(false));
  });

  it('does not cancel when the press lands inside the dialog', async () => {
    const onResult = vi.fn();
    open(onResult);
    fireEvent.mouseDown(screen.getByRole('alertdialog'));
    // A drag that starts on the text and ends outside must not read as dismissal.
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(onResult).not.toHaveBeenCalled();
    expect(screen.getByRole('alertdialog')).toBeTruthy();
  });

  it('starts with focus on Cancel, so a stray Enter destroys nothing', () => {
    open(vi.fn());
    expect(document.activeElement).toBe(screen.getByText('Cancel'));
  });

  it('describes itself to a screen reader', () => {
    open(vi.fn());
    const dialog = screen.getByRole('alertdialog');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(document.getElementById(dialog.getAttribute('aria-labelledby')!)?.textContent)
      .toBe('Delete this note for good?');
    expect(document.getElementById(dialog.getAttribute('aria-describedby')!)?.textContent)
      .toBe('This note is not in Trash. Deleting it here cannot be undone.');
  });

  it('spends the danger treatment only on what is unrecoverable', () => {
    const { unmount } = render(
      <ConfirmProvider><Trigger onResult={vi.fn()} /></ConfirmProvider>,
    );
    fireEvent.click(screen.getByText('ask'));
    expect(screen.getByText('Delete for good').className).toContain('confirm__btn--danger');
    unmount();
    cleanup();

    open(vi.fn(), {
      title: 'Sign out everywhere?',
      body: 'Other devices will have to sign in again.',
      confirmLabel: 'Sign out',
      cancelLabel: 'Stay signed in',
    });
    expect(screen.getByText('Sign out').className).not.toContain('confirm__btn--danger');
    expect(screen.getByText('Stay signed in')).toBeTruthy();
  });

  it('goes away once it has been answered', async () => {
    const onResult = vi.fn();
    open(onResult);
    fireEvent.click(screen.getByText('Cancel'));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
  });

  it('can be asked again after it has been answered', async () => {
    const onResult = vi.fn();
    open(onResult);
    fireEvent.click(screen.getByText('Cancel'));
    await waitFor(() => expect(onResult).toHaveBeenCalledWith(false));

    fireEvent.click(screen.getByText('ask'));
    expect(screen.getByRole('alertdialog')).toBeTruthy();
    fireEvent.click(screen.getByText('Delete for good'));
    await waitFor(() => expect(onResult).toHaveBeenLastCalledWith(true));
    expect(onResult).toHaveBeenCalledTimes(2);
  });

  it('refuses by default outside the provider', async () => {
    const onResult = vi.fn();
    render(<Trigger onResult={onResult} />);
    fireEvent.click(screen.getByText('ask'));
    // Nothing to answer, and nothing is destroyed: the safe answer is no.
    await waitFor(() => expect(onResult).toHaveBeenCalledWith(false));
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });
});
