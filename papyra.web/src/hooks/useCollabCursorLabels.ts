import { useEffect, type RefObject } from 'react';

/** A remote caret's name label shows while its owner moves, then fades. */
export const LABEL_IDLE_MS = 3_000;

/**
 * Keep remote name labels quiet: each is shown while its caret moves and fades
 * LABEL_IDLE_MS later. Lexical paints cursors itself (inline-styled spans in
 * the container) and re-writes every cursor's style on any peer's move, so a
 * real move is a style change *to a different value*.
 *
 * Lexical portals its own <div> into our container; selection rects are that
 * div's children: container > div > rect span > [tint, caret > label].
 */
/**
 * `mountKey`: null while no live editor is mounted; change it whenever the
 * cursors container is re-created (a remount), so the observer follows it.
 */
export function useCollabCursorLabels(containerRef: RefObject<HTMLElement | null>, mountKey: string | null) {
  useEffect(() => {
    const container = containerRef.current;
    if (mountKey === null || !container) return;
    const timers = new Map<Element, ReturnType<typeof setTimeout>>();
    const isRect = (el: Element | null) => !!el && el.parentElement?.parentElement === container;
    const wake = (el: Element) => {
      el.setAttribute('data-collab-active', '');
      clearTimeout(timers.get(el));
      timers.set(el, setTimeout(() => {
        el.removeAttribute('data-collab-active');
        timers.delete(el);
      }, LABEL_IDLE_MS));
    };
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        if (record.type === 'childList') {
          // A new selection rect, or the caret moving into another rect.
          record.addedNodes.forEach((node) => { if (node instanceof Element && isRect(node)) wake(node); });
          if (isRect(record.target as Element) && record.addedNodes.length) wake(record.target as Element);
          continue;
        }
        const el = record.target as Element;
        if (isRect(el) && record.oldValue !== el.getAttribute('style')) wake(el);
      }
    });
    observer.observe(container, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['style'],
      attributeOldValue: true,
    });
    return () => {
      observer.disconnect();
      timers.forEach((t) => clearTimeout(t));
    };
  }, [containerRef, mountKey]);
}

