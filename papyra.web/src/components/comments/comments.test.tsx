// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import CommentComposer from './CommentComposer';
import { toggle, type Reaction } from '../../hooks/useComments';

afterEach(cleanup);

const people = [
  { id: 1, username: 'owner', name: 'Olive Owner' },
  { id: 2, username: 'bea', name: 'Bea Brook' },
  { id: 3, username: 'bert', name: 'Bert' },
];

function type(el: HTMLTextAreaElement, value: string) {
  fireEvent.change(el, { target: { value, selectionStart: value.length } });
}

describe('CommentComposer', () => {
  it('@ lists only people who can see the note, and inserts the handle', () => {
    render(<CommentComposer people={people} placeholder="Add a comment" submitLabel="Comment" onSubmit={vi.fn()} />);
    const box = screen.getByLabelText('Add a comment') as HTMLTextAreaElement;
    type(box, 'ping @be');
    const options = screen.getAllByRole('option');
    expect(options.map(o => o.textContent)).toEqual(['Bea Brook@bea', 'Bert@bert']);
    fireEvent.keyDown(box, { key: 'ArrowDown' });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(box.value).toBe('ping @bert ');
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('an email address is not a mention', () => {
    render(<CommentComposer people={people} placeholder="Add a comment" submitLabel="Comment" onSubmit={vi.fn()} />);
    type(screen.getByLabelText('Add a comment') as HTMLTextAreaElement, 'mail me@be');
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('Ctrl+Enter sends trimmed text, empty never sends, a failure keeps the draft', async () => {
    const onSubmit = vi.fn().mockRejectedValueOnce(new Error('Couldn’t save the comment (500).')).mockResolvedValue(undefined);
    render(<CommentComposer people={people} placeholder="Add a comment" submitLabel="Comment" onSubmit={onSubmit} />);
    const box = screen.getByLabelText('Add a comment') as HTMLTextAreaElement;
    fireEvent.keyDown(box, { key: 'Enter', ctrlKey: true });
    expect(onSubmit).not.toHaveBeenCalled();
    expect((screen.getByText('Comment') as HTMLButtonElement).disabled).toBe(true);

    type(box, '  hello  ');
    await act(async () => { fireEvent.keyDown(box, { key: 'Enter', ctrlKey: true }); });
    expect(onSubmit).toHaveBeenLastCalledWith('hello');
    expect(screen.getByRole('alert').textContent).toContain('500');
    expect(box.value).toBe('  hello  ');

    await act(async () => { fireEvent.keyDown(box, { key: 'Enter', metaKey: true }); });
    expect(box.value).toBe('');
  });

  it('Escape cancels, and never reaches the note behind it', () => {
    const onCancel = vi.fn();
    const noteEscape = vi.fn();
    window.addEventListener('keydown', noteEscape);
    render(<CommentComposer people={people} placeholder="Add a comment" submitLabel="Comment" onSubmit={vi.fn()} onCancel={onCancel} />);
    fireEvent.keyDown(screen.getByLabelText('Add a comment'), { key: 'Escape' });
    expect(onCancel).toHaveBeenCalled();
    expect(noteEscape).not.toHaveBeenCalled();
    window.removeEventListener('keydown', noteEscape);
  });
});

describe('reaction toggle (optimistic)', () => {
  const order = ['👍', '❤️', '😂'];
  it('adds, counts, keeps order, and takes back', () => {
    let r: Reaction[] = [{ emoji: '❤️', count: 1, mine: false, people: ['bea'] }];
    r = toggle(r, '👍', 'me', order);
    expect(r.map(x => x.emoji)).toEqual(['👍', '❤️']);
    r = toggle(r, '❤️', 'me', order);
    expect(r[1]).toMatchObject({ count: 2, mine: true, people: ['bea', 'me'] });
    r = toggle(r, '👍', 'me', order);
    expect(r.map(x => x.emoji)).toEqual(['❤️']);
    r = toggle(r, '❤️', 'me', order);
    expect(r[0]).toMatchObject({ count: 1, mine: false, people: ['bea'] });
  });
});
