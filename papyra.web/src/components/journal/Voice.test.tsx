// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import VoiceRecorder from './VoiceRecorder';
import PhotoStrip from './PhotoStrip';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

/** A MediaRecorder that records "abc" and stops when told. */
class FakeRecorder {
  static isTypeSupported = (m: string) => m === 'audio/webm;codecs=opus';
  state: 'inactive' | 'recording' = 'inactive';
  mimeType: string;
  ondataavailable: ((e: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  constructor(_stream: unknown, options: { mimeType: string }) { this.mimeType = options.mimeType; }
  start() { this.state = 'recording'; this.ondataavailable?.({ data: new Blob(['abc'], { type: this.mimeType }) }); }
  stop() { this.state = 'inactive'; queueMicrotask(() => this.onstop?.()); }
}

const track = { stop: vi.fn() };
const mic = (impl: () => Promise<unknown>) =>
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: vi.fn(impl) } });

beforeEach(() => {
  track.stop.mockClear();
  vi.stubGlobal('MediaRecorder', FakeRecorder);
  mic(async () => ({ getTracks: () => [track] }));
});

describe('VoiceRecorder', () => {
  it('records, then hands the file over and closes', async () => {
    const onFile = vi.fn().mockResolvedValue(undefined);
    const onClose = vi.fn();
    render(<VoiceRecorder day="2026-10-24" transcribe={false} onFile={onFile} onClose={onClose} />);

    expect(await screen.findByText('Recording')).toBeTruthy();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /stop/i })); });

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    const file = onFile.mock.calls[0][0] as File;
    expect(file.name).toMatch(/^voice-2026-10-24-\d{4}\.weba$/);
    expect(await file.text()).toBe('abc');
    expect(track.stop).toHaveBeenCalled(); // the microphone is let go
  });

  it('says why when the microphone is refused, and records nothing', async () => {
    mic(async () => { throw new DOMException('no', 'NotAllowedError'); });
    const onFile = vi.fn();
    render(<VoiceRecorder day="2026-10-24" transcribe={false} onFile={onFile} onClose={vi.fn()} />);
    expect((await screen.findByText(/can’t use the microphone/)).textContent).toMatch(/site settings/);
    expect(screen.queryByRole('button', { name: /stop/i })).toBeNull();
    expect(onFile).not.toHaveBeenCalled();
  });

  it('Esc throws the take away and lets the microphone go', async () => {
    const onFile = vi.fn();
    const onClose = vi.fn();
    render(<VoiceRecorder day="2026-10-24" transcribe={false} onFile={onFile} onClose={onClose} />);
    await screen.findByText('Recording');
    fireEvent.keyDown(screen.getByRole('group', { name: 'Voice note' }), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onFile).not.toHaveBeenCalled();
    cleanup();
    expect(track.stop).toHaveBeenCalled();
  });

  it('keeps the take when the upload fails, and sends it again on request', async () => {
    const onFile = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(undefined);
    const onClose = vi.fn();
    render(<VoiceRecorder day="2026-10-24" transcribe={false} onFile={onFile} onClose={onClose} />);
    await screen.findByText('Recording');
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /stop/i })); });

    expect(await screen.findByText('Couldn’t add the recording.')).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /try again/i })); });

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(onFile).toHaveBeenCalledTimes(2);
    expect(onFile.mock.calls[1][0]).toBe(onFile.mock.calls[0][0]); // the same recording
  });
});

describe('PhotoStrip', () => {
  const root = () => {
    const el = document.createElement('div');
    el.innerHTML = '<p><img src="/api/media/b.png"></p><p><img src="/api/media/a.jpg"></p>';
    el.querySelectorAll('img').forEach((img) => { img.scrollIntoView = vi.fn(); });
    return el;
  };

  it('waits for a second picture', () => {
    const { container } = render(<PhotoStrip markdown="![[a.jpg]] and a voice ![[v.weba]]" root={() => null} />);
    expect(container.firstChild).toBeNull();
  });

  it('shows small thumbnails in order, and scrolls the page to the one chosen', () => {
    const page = root();
    render(<PhotoStrip markdown="![[a.jpg]]\n\n![[b.png]]" root={() => page} />);
    const buttons = screen.getAllByRole('button');
    expect(buttons.map((b) => b.getAttribute('aria-label'))).toEqual(['Photo 1 of 2: a.jpg', 'Photo 2 of 2: b.png']);
    expect(buttons[0].querySelector('img')?.getAttribute('src')).toBe('/api/media/a.jpg/thumb?w=160');

    fireEvent.click(buttons[1]);
    expect((page.querySelector('img[src$="b.png"]') as HTMLImageElement).scrollIntoView).toHaveBeenCalled();
    expect((page.querySelector('img[src$="a.jpg"]') as HTMLImageElement).scrollIntoView).not.toHaveBeenCalled();
  });
});
