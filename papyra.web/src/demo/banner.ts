// The strip that says "this is a demo" — and the way back to the website.
//
// Mounted from the demo module rather than added to the app's component tree, so
// no page, layout or component in papyra.web has to know the demo exists. Plain
// DOM for the same reason — it lives outside React's root entirely.
//
// It never fully disappears: hiding it folds it into a small pill that still
// links back to papyra.app, so a visitor is never stranded inside the app.

import { resetState } from './store';

const COLLAPSED = 'papyra-demo-banner-dismissed';

const ARROW =
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M19 12H5M12 19l-7-7 7-7"/></svg>';

export function mountDemoBanner(): void {
  if (document.querySelector('.demo-banner')) return;

  const style = document.createElement('style');
  style.textContent = `
    .demo-banner {
      position: fixed;
      inset-block-end: var(--space-4, 16px);
      inset-inline: var(--space-4, 16px);
      z-index: 9999;
      margin-inline: auto;
      width: max-content;
      max-width: min(52rem, calc(100vw - 2rem));
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: var(--space-3, 12px);
      padding: 8px 8px 8px var(--space-4, 16px);
      border: 1px solid var(--accent-border);
      border-radius: var(--radius-pill, 999px);
      background: var(--surface);
      box-shadow: var(--shadow);
      font: 400 var(--fs-sm, 14px) / 1.35 var(--sans);
      color: var(--text);
    }
    .demo-banner__dot {
      width: 8px;
      height: 8px;
      border-radius: 999px;
      background: var(--accent);
      flex: none;
      box-shadow: 0 0 0 4px var(--accent-bg);
    }
    .demo-banner__text { margin: 0; }
    .demo-banner__text strong { color: var(--text-h); font-weight: 600; }
    .demo-banner__actions { display: flex; gap: var(--space-2, 8px); margin-left: auto; }
    .demo-banner button,
    .demo-banner a {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 7px 12px;
      border-radius: var(--radius-pill, 999px);
      border: 1px solid var(--border);
      background: transparent;
      color: var(--text-h);
      font: 500 var(--fs-xs, 12.5px) / 1 var(--sans);
      text-decoration: none;
      cursor: pointer;
      white-space: nowrap;
    }
    .demo-banner a.demo-banner__cta {
      border-color: var(--accent);
      background: var(--accent);
      color: var(--accent-fg);
    }
    .demo-banner button:hover,
    .demo-banner a:hover { border-color: var(--accent-border); background: var(--accent-bg); }
    .demo-banner a.demo-banner__cta:hover { background: var(--accent-hover); border-color: var(--accent-hover); color: var(--accent-fg); }

    /* Folded: just the way home, tucked into the corner. */
    .demo-banner--collapsed {
      inset-inline: auto var(--space-4, 16px);
      margin-inline: 0;
      padding: 4px;
      gap: 4px;
    }
    .demo-banner--collapsed :is(.demo-banner__dot, .demo-banner__text, .demo-banner__reset, .demo-banner__cta, .demo-banner__hide) { display: none; }
    .demo-banner:not(.demo-banner--collapsed) .demo-banner__more { display: none; }
    .demo-banner--collapsed .demo-banner__actions { margin-left: 0; gap: 4px; }
    .demo-banner--collapsed :is(button, a) { border-color: transparent; }
    /* An open note has its own bottom bar (and Close) right where this sits. */
    body:has(.note-modal) .demo-banner { display: none; }

    @media (max-width: 40rem) {
      .demo-banner:not(.demo-banner--collapsed) { border-radius: var(--radius-md, 12px); width: auto; padding: 10px; gap: 8px; }
      .demo-banner:not(.demo-banner--collapsed) .demo-banner__actions { margin-left: 0; width: 100%; gap: 6px; }
      .demo-banner:not(.demo-banner--collapsed) :is(button, a) { padding: 7px 10px; }
      .demo-banner__hide { margin-left: auto; }
    }
    /* A selection's action bar sits in the same spot; it wins while it is up. */
    body:has(.bulk-bar) .demo-banner { display: none; }
    /* Toasts (and their Undo) share the bottom centre: keep them above the strip. */
    body:has(.demo-banner:not(.demo-banner--collapsed)):not(:has(.note-modal)) .toasts { bottom: calc(var(--space-6, 24px) + 72px); }
    @media (max-width: 40rem) { body:has(.demo-banner:not(.demo-banner--collapsed)):not(:has(.note-modal)) .toasts { bottom: calc(var(--space-6, 24px) + 132px); } }
    body:has(.bulk-bar) .toasts { bottom: calc(max(20px, env(safe-area-inset-bottom)) + 64px); }
    @media print { .demo-banner { display: none; } }
  `;
  document.head.append(style);

  const bar = document.createElement('aside');
  bar.className = 'demo-banner';
  bar.setAttribute('aria-label', 'Demo notice');

  const dot = document.createElement('span');
  dot.className = 'demo-banner__dot';

  const text = document.createElement('p');
  text.className = 'demo-banner__text';
  text.innerHTML = '<strong>Live demo.</strong> Runs in your browser — nothing leaves it.';

  const actions = document.createElement('div');
  actions.className = 'demo-banner__actions';

  // Same origin as the website, so this is a plain link home.
  const home = document.createElement('a');
  home.className = 'demo-banner__home';
  home.href = '/';
  home.innerHTML = `${ARROW}<span>papyra.app</span>`;

  const reset = document.createElement('button');
  reset.type = 'button';
  reset.className = 'demo-banner__reset';
  reset.textContent = 'Start over';
  reset.addEventListener('click', () => {
    resetState();
    // A full reload is the honest way to reset: it rebuilds every cache and
    // re-runs the app exactly as a first-time visitor would see it.
    window.location.href = import.meta.env.BASE_URL;
  });

  const install = document.createElement('a');
  install.className = 'demo-banner__cta';
  install.href = '/docs/install/';
  install.textContent = 'Install Papyra';

  const setCollapsed = (collapsed: boolean) => {
    bar.classList.toggle('demo-banner--collapsed', collapsed);
    try {
      if (collapsed) sessionStorage.setItem(COLLAPSED, '1');
      else sessionStorage.removeItem(COLLAPSED);
    } catch {
      /* private mode — it just comes back expanded on the next page load */
    }
  };

  const hide = document.createElement('button');
  hide.type = 'button';
  hide.className = 'demo-banner__hide';
  hide.textContent = 'Hide';
  hide.setAttribute('aria-label', 'Fold the demo notice away');
  hide.addEventListener('click', () => setCollapsed(true));

  const more = document.createElement('button');
  more.type = 'button';
  more.className = 'demo-banner__more';
  more.textContent = 'Demo';
  more.setAttribute('aria-label', 'Show the demo notice');
  more.addEventListener('click', () => setCollapsed(false));

  actions.append(home, reset, install, hide, more);
  bar.append(dot, text, actions);

  try {
    if (sessionStorage.getItem(COLLAPSED) === '1') bar.classList.add('demo-banner--collapsed');
  } catch {
    /* storage unavailable — show it expanded */
  }
  document.body.append(bar);
}
