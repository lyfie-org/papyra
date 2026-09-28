import { useEffect, type RefObject } from 'react';

/**
 * Keeps `[[wikilink]]` clicks inside the app.
 *
 * luthor renders a wikilink as `<a href="#">` and routes its click to the
 * adapter's `openNote`. But Lexical's ClickableLinkPlugin (the link extension
 * is configured `openLinksInNewTab`) also listens on the editor root, falls
 * back to any plain anchor under the pointer, and calls
 * `window.open(".../note/x#", "_blank")` — so one click navigated the note
 * *and* opened a second browser tab. In an installed PWA that tab is a whole
 * browser window outside the app.
 *
 * Catching the click in the capture phase, above the editor root, lets us
 * route it once and keep it from ever reaching either listener. Ctrl/⌘ and
 * middle clicks are swallowed too: the href is `#`, so a "new tab" would only
 * ever reopen the note already on screen.
 */
export function useInPlaceWikilinks(
  containerRef: RefObject<HTMLElement | null>,
  openNote: (target: string) => void,
) {
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onClick = (e: MouseEvent) => {
      const link = (e.target as Element | null)?.closest?.('.luthor-wikilink[data-luthor-wikilink-target]');
      if (!link) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.type === 'click') openNote(link.getAttribute('data-luthor-wikilink-target') ?? '');
    };
    el.addEventListener('click', onClick, true);
    el.addEventListener('auxclick', onClick, true);
    return () => {
      el.removeEventListener('click', onClick, true);
      el.removeEventListener('auxclick', onClick, true);
    };
  }, [containerRef, openNote]);
}
