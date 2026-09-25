// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import NoteHistory, { type HistoryVersion, type HistoryView } from './NoteHistory';

// History is where someone goes after something went wrong, so these pin the
// parts that could make it worse: the canvas only ever shows the version that
// was actually picked (a slow earlier fetch never wins), "Now" never offers a
// restore, a locked note says so instead of failing silently, and Esc/close
// always hand the live note back.

vi.mock('../lib/vault', () => ({
  vaultFetch: (url: string, init?: RequestInit) => globalThis.fetch(url, init),
}));

type Handler = (url: string) => Promise<Response> | Response;
let handler: Handler;

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

const VERSIONS = [
  { id: '300', timestamp: '2026-09-25T12:00:00Z' },
  { id: '100', timestamp: '2026-09-24T10:00:00Z' },
  { id: '200', timestamp: '2026-09-25T09:00:00Z' },
];
const BODIES: Record<string, HistoryVersion> = {
  '100': { title: 'Trip', body: 'one\ntwo' },
  '200': { title: 'Trip', body: 'one\ntwo\nthree' },
  '300': { title: 'Trip plan', body: 'one\ntwo\nthree\nfour' },
};
const LIVE: HistoryVersion = { title: 'Trip plan', body: 'one\ntwo\nthree\nfour\nfive' };

function standard(url: string): Response {
  if (url.endsWith('/snapshots')) return json(VERSIONS);
  const id = url.split('/').pop()!;
  return BODIES[id] ? json(BODIES[id]) : json({}, 404);
}

function setup(overrides: Partial<Parameters<typeof NoteHistory>[0]> = {}) {
  const onPreview = vi.fn();
  const onRestore = vi.fn(async () => {});
  const onClose = vi.fn();
  let view: HistoryView = 'preview';
  const onViewChange = vi.fn((v: HistoryView) => { view = v; rerender(); });
  const props = () => ({ noteId: 'n1', live: LIVE, onPreview, onRestore, onClose, view, onViewChange, ...overrides });
  const utils = render(<NoteHistory {...props()} />);
  function rerender() { utils.rerender(<NoteHistory {...props()} />); }
  return { onPreview, onRestore, onClose, onViewChange, ...utils };
}

beforeEach(() => {
  handler = standard;
  vi.stubGlobal('fetch', vi.fn((url: string) => Promise.resolve(handler(url))));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const slider = () => screen.getByRole('slider', { name: 'Version timeline' });

describe('NoteHistory', () => {
  it('opens on the most recent earlier version and previews it', async () => {
    const { onPreview } = setup();
    await waitFor(() => expect(onPreview).toHaveBeenLastCalledWith(BODIES['300']));
    expect(slider().getAttribute('aria-valuenow')).toBe('2');
    expect(slider().getAttribute('aria-valuemax')).toBe('3');
    expect(screen.getByText('3 of 3')).toBeTruthy();
    // live has one more line than version 300
    expect(screen.getByTitle('Compared with the note now').textContent).toContain('+1');
  });

  it('steps with arrows and keys; Now hands the live note back and cannot be restored', async () => {
    const { onPreview } = setup();
    await waitFor(() => expect(onPreview).toHaveBeenLastCalledWith(BODIES['300']));

    fireEvent.keyDown(slider(), { key: 'ArrowLeft' });
    await waitFor(() => expect(onPreview).toHaveBeenLastCalledWith(BODIES['200']));
    fireEvent.keyDown(slider(), { key: 'Home' });
    await waitFor(() => expect(onPreview).toHaveBeenLastCalledWith(BODIES['100']));
    expect((screen.getByRole('button', { name: 'Older version' }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.keyDown(slider(), { key: 'End' });
    await waitFor(() => expect(onPreview).toHaveBeenLastCalledWith(null));
    expect(screen.getByText('Current version')).toBeTruthy();
    expect((screen.getByRole('button', { name: /Restore this version/ }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Newer version' }) as HTMLButtonElement).disabled).toBe(true);

    // Past the ends is clamped, not wrapped.
    fireEvent.keyDown(slider(), { key: 'ArrowRight' });
    expect(slider().getAttribute('aria-valuenow')).toBe('3');
  });

  it('never lets a slow earlier fetch overwrite the version picked after it', async () => {
    let releaseSlow!: () => void;
    handler = (url) => {
      if (url.endsWith('/200')) {
        return new Promise((resolve) => { releaseSlow = () => resolve(json(BODIES['200'])); });
      }
      return standard(url);
    };
    const { onPreview } = setup();
    await waitFor(() => expect(onPreview).toHaveBeenLastCalledWith(BODIES['300']));

    fireEvent.keyDown(slider(), { key: 'ArrowLeft' });   // → 200 (slow, pending)
    fireEvent.keyDown(slider(), { key: 'Home' });        // → 100 (fast)
    await waitFor(() => expect(onPreview).toHaveBeenLastCalledWith(BODIES['100']));
    await act(async () => { releaseSlow(); await Promise.resolve(); });
    expect(onPreview).toHaveBeenLastCalledWith(BODIES['100']);
    expect(onPreview).not.toHaveBeenCalledWith(BODIES['200']);
  });

  it('restores the selected version with a readable label', async () => {
    const { onRestore, onPreview } = setup();
    await waitFor(() => expect(onPreview).toHaveBeenLastCalledWith(BODIES['300']));
    fireEvent.click(screen.getByRole('button', { name: /Restore this version/ }));
    await waitFor(() => expect(onRestore).toHaveBeenCalledTimes(1));
    expect(onRestore).toHaveBeenCalledWith('300', expect.stringMatching(/Sep 25/));
  });

  it('reports a failed restore and lets the person try again', async () => {
    const onRestore = vi.fn(async () => { throw new Error('boom'); });
    const { onPreview } = setup({ onRestore });
    await waitFor(() => expect(onPreview).toHaveBeenLastCalledWith(BODIES['300']));
    fireEvent.click(screen.getByRole('button', { name: /Restore this version/ }));
    expect((await screen.findByRole('alert')).textContent).toContain('Restore failed — nothing was changed.');
    expect((screen.getByRole('button', { name: /Restore this version/ }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('says a locked note must be unlocked, and offers no restore', async () => {
    handler = (url) => (url.endsWith('/snapshots') ? json(VERSIONS) : json({ code: 'locked' }, 401));
    const { onPreview } = setup();
    expect((await screen.findByRole('alert')).textContent).toContain('Unlock this note to see its history.');
    expect(onPreview).not.toHaveBeenCalledWith(expect.objectContaining({ body: expect.any(String) }));
    expect((screen.getByRole('button', { name: /Restore this version/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('explains an empty history instead of showing a dead timeline', async () => {
    handler = (url) => (url.endsWith('/snapshots') ? json([]) : json({}, 404));
    setup();
    expect(await screen.findByText(/No earlier versions yet/)).toBeTruthy();
    expect(screen.queryByRole('slider')).toBeNull();
    expect(screen.queryByRole('button', { name: /Restore/ })).toBeNull();
  });

  it('shows a load failure', async () => {
    handler = () => json({}, 500);
    setup();
    expect((await screen.findByRole('alert')).textContent).toContain('Couldn’t load this note’s history.');
  });

  it('closes on Escape and on the close button', async () => {
    const { onClose, onPreview } = setup();
    await waitFor(() => expect(onPreview).toHaveBeenCalled());
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Close history' }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('Changes view diffs against now, shows a title change, and folds unchanged runs', async () => {
    const long = Array.from({ length: 30 }, (_, i) => `line ${i}`);
    const v = { title: 'Old title', body: long.join('\n') };
    const live = { title: 'New title', body: long.map((l) => (l === 'line 15' ? 'line fifteen' : l)).join('\n') };
    handler = (url) => (url.endsWith('/snapshots') ? json([{ id: '1', timestamp: '2026-09-25T10:00:00Z' }]) : json(v));
    const { onPreview } = setup({ live });
    await waitFor(() => expect(onPreview).toHaveBeenLastCalledWith(v));

    fireEvent.click(screen.getByRole('button', { name: 'Changes' }));
    const region = await screen.findByRole('region', { name: 'Changes since this version' });
    expect(region.textContent).toContain('Old title');
    expect(region.textContent).toContain('New title');
    expect(region.textContent).toContain('line fifteen');
    const folds = screen.getAllByRole('button', { name: /unchanged lines/ });
    expect(folds).toHaveLength(2);
    expect(region.textContent).not.toContain('line 0');

    fireEvent.click(folds[0]);
    expect(region.textContent).toContain('line 0');
  });

  it('diffs without the hidden block anchors', async () => {
    const v = { title: 'T', body: 'Para ^abc12345\nsecond ^def67890' };
    const live = { title: 'T', body: 'Para ^abc12345\nsecond changed ^def67890' };
    handler = (url) => (url.endsWith('/snapshots') ? json([{ id: '1', timestamp: '2026-09-25T10:00:00Z' }]) : json(v));
    const { onPreview } = setup({ live });
    await waitFor(() => expect(onPreview).toHaveBeenLastCalledWith(v));
    fireEvent.click(screen.getByRole('button', { name: 'Changes' }));
    const region = await screen.findByRole('region', { name: 'Changes since this version' });
    expect(region.textContent).not.toMatch(/\^abc|\^def/);
  });
});
