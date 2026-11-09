import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  HIDE_GRACE_MS, needsDescription, place, resolveTip, showDelay, type Resolved, type TipContent,
} from '../lib/tooltip';
import './TooltipLayer.css';

const TIP_ID = 'papyra-tooltip';

interface Engaged {
  host: HTMLElement;
  content: TipContent;
  /** A `title` taken off the element while its tooltip is pending or shown; handed back afterwards. */
  lentTitle: string | null;
  described: boolean;
}

/**
 * Papyra's one tooltip. Mounted once; any element can ask for it with `data-tooltip` (and `data-tooltip-keys`
 * for a shortcut). See `lib/tooltip.ts` for how the text is found.
 *
 * - Opens on hover after a short wait (at once when moving from one control to the next), and on keyboard focus.
 * - Closes on Escape, blur, scroll, a click, or when the pointer leaves, with a moment of grace so the pointer can
 *   move onto the tooltip itself: it stays open while pointed at or focused, and can be read at length (WCAG 1.4.13).
 * - Lives in a portal, so no card or scroll box can clip it, and flips above a control near the bottom of the window.
 * - Linked to its control with `aria-describedby`, but only when it adds something to the control's name.
 * - Touch has no hover, so it ignores touch. A control must still have an accessible name of its own.
 */
export default function TooltipLayer() {
  const [shown, setShown] = useState<{ content: TipContent; host: HTMLElement } | null>(null);
  const tipEl = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let engaged: Engaged | null = null;
    let visible = false;
    let showTimer: number | undefined;
    let hideTimer: number | undefined;
    let watch: number | undefined;
    let lastHiddenAt: number | null = null;

    const inTip = (n: EventTarget | null) => !!tipEl.current && n instanceof Node && tipEl.current.contains(n);
    const inHost = (n: EventTarget | null) => !!engaged && n instanceof Node && engaged.host.contains(n);

    function release() {
      window.clearTimeout(showTimer);
      window.clearTimeout(hideTimer);
      window.clearInterval(watch);
      if (engaged) {
        if (engaged.lentTitle !== null) engaged.host.setAttribute('title', engaged.lentTitle);
        if (engaged.described) engaged.host.removeAttribute('aria-describedby');
      }
      engaged = null;
    }

    function hide() {
      const wasVisible = visible;
      release();
      visible = false;
      if (wasVisible) { lastHiddenAt = performance.now(); setShown(null); }
    }

    function engage(r: Resolved) {
      release();
      const { host, content } = r;
      // The browser's own tooltip would open over ours: take the title away until we're done.
      const lentTitle = r.source === 'title' ? host.getAttribute('title') : null;
      if (lentTitle !== null) host.removeAttribute('title');
      engaged = { host, content, lentTitle, described: false };
    }

    function reveal() {
      if (!engaged) return;
      const { host, content } = engaged;
      if (!host.isConnected) { hide(); return; }
      if (needsDescription(host, content.text) && !host.hasAttribute('aria-describedby')) {
        host.setAttribute('aria-describedby', TIP_ID);
        engaged.described = true;
      }
      visible = true;
      setShown({ content, host });
      // The control can disappear while its tooltip is up (a menu closes, a list re-renders).
      window.clearInterval(watch);
      watch = window.setInterval(() => { if (!host.isConnected) hide(); }, 400);
    }

    function scheduleHide() {
      window.clearTimeout(hideTimer);
      if (!visible) { hide(); return; }                    // nothing shown yet: just drop the wait
      hideTimer = window.setTimeout(hide, HIDE_GRACE_MS);
    }

    const onOver = (e: PointerEvent) => {
      if (e.pointerType === 'touch') return;
      if (inTip(e.target)) { window.clearTimeout(hideTimer); return; }       // reading it: keep it
      const r = resolveTip(e.target as Element | null);
      if (!r) return;
      if (engaged && r.host === engaged.host) { window.clearTimeout(hideTimer); return; }
      const warm = visible;
      engage(r);
      window.clearTimeout(showTimer);
      const wait = warm ? 0 : showDelay(performance.now(), lastHiddenAt);
      if (wait === 0) reveal(); else showTimer = window.setTimeout(reveal, wait);
    };

    const onOut = (e: PointerEvent) => {
      if (!engaged || e.pointerType === 'touch') return;
      if (!inHost(e.target) && !inTip(e.target)) return;
      const to = e.relatedTarget;
      if (inHost(to) || inTip(to)) return;
      scheduleHide();
    };

    const onFocusIn = (e: FocusEvent) => {
      const target = e.target;
      if (!(target instanceof HTMLElement)) return;
      // Typing surfaces (the editor, form fields) never get one.
      if (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      let keyboard = true;
      try { keyboard = target.matches(':focus-visible'); } catch { /* an old engine: assume the keyboard */ }
      if (!keyboard) return;
      const r = resolveTip(target);
      if (!r) return;
      engage(r);
      reveal();
    };

    const onFocusOut = (e: FocusEvent) => { if (engaged && inHost(e.target)) hide(); };

    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || !visible) return;
      // Closes the tooltip and nothing else: the dialog behind it stays open for the next press.
      e.stopPropagation();
      hide();
    };

    const onAway = (e: Event) => { if (!inTip(e.target)) hide(); };

    document.addEventListener('pointerover', onOver, true);
    document.addEventListener('pointerout', onOut, true);
    document.addEventListener('focusin', onFocusIn);
    document.addEventListener('focusout', onFocusOut);
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('pointerdown', onAway, true);
    document.addEventListener('scroll', onAway, true);
    document.addEventListener('wheel', onAway, { capture: true, passive: true });
    window.addEventListener('resize', hide);
    return () => {
      document.removeEventListener('pointerover', onOver, true);
      document.removeEventListener('pointerout', onOut, true);
      document.removeEventListener('focusin', onFocusIn);
      document.removeEventListener('focusout', onFocusOut);
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('pointerdown', onAway, true);
      document.removeEventListener('scroll', onAway, true);
      document.removeEventListener('wheel', onAway, true);
      window.removeEventListener('resize', hide);
      hide();
    };
  }, []);

  // Runs when the tooltip appears: measure it and put it where it fits. Done on the element itself (not in state)
  // so it never paints in the wrong place first.
  const position = useCallback((el: HTMLDivElement | null) => {
    tipEl.current = el;
    if (!el || !shown) return;
    const a = shown.host.getBoundingClientRect();
    const box = el.getBoundingClientRect();
    const p = place(
      { x: a.x, y: a.y, width: a.width, height: a.height },
      { width: box.width, height: box.height },
      { width: document.documentElement.clientWidth, height: document.documentElement.clientHeight },
    );
    el.style.left = `${Math.round(p.x)}px`;
    el.style.top = `${Math.round(p.y)}px`;
    el.dataset.side = p.side;
    el.dataset.ready = 'true';
  }, [shown]);

  if (!shown) return null;
  const { text, keys } = shown.content;
  return createPortal(
    <div ref={position} id={TIP_ID} role="tooltip" className="tip">
      <span className="tip__text">{text}</span>
      {keys.length > 0 && (
        <span className="tip__keys">
          {keys.map((k, i) => <kbd key={i} className="tip__key">{k}</kbd>)}
        </span>
      )}
    </div>,
    document.body,
  );
}
