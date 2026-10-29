/**
 * The browser's own audio player has a "more options" button (download, playback speed) that
 * sits on the page's own media bar and clashes with it — which already offers Download. With
 * every item in that menu switched off, the browser drops the button.
 * Players come and go as the editor draws them, so this watches the container.
 */
const CONTROLS = 'nodownload noplaybackrate';

export function trimAudioControls(container: HTMLElement): () => void {
  const apply = (root: ParentNode) => {
    root.querySelectorAll('audio').forEach((a) => {
      if (a.getAttribute('controlsList') !== CONTROLS) a.setAttribute('controlsList', CONTROLS);
    });
  };
  apply(container);
  const observer = new MutationObserver(() => apply(container));
  observer.observe(container, { childList: true, subtree: true });
  return () => observer.disconnect();
}
