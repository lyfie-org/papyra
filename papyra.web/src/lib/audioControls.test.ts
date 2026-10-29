// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { trimAudioControls } from './audioControls';

describe('trimAudioControls', () => {
  it('turns off the player menu on audio already there and on audio drawn later', async () => {
    const root = document.createElement('div');
    root.innerHTML = '<audio controls></audio>';
    const stop = trimAudioControls(root);
    expect(root.querySelector('audio')!.getAttribute('controlsList')).toBe('nodownload noplaybackrate');

    const later = document.createElement('figure');
    later.appendChild(document.createElement('audio'));
    root.appendChild(later);
    await new Promise((r) => setTimeout(r, 0));
    expect(later.querySelector('audio')!.getAttribute('controlsList')).toBe('nodownload noplaybackrate');

    stop();
    const after = document.createElement('audio');
    root.appendChild(after);
    await new Promise((r) => setTimeout(r, 0));
    expect(after.hasAttribute('controlsList')).toBe(false);
  });
});
