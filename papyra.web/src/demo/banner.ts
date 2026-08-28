// The strip that says "this is a demo".
//
// Mounted from the demo module rather than added to the app's component tree, so
// no page, layout or component in papyra.web has to know the demo exists. Plain
// DOM for the same reason — it lives outside React's root entirely.

import { resetState } from './store';

const DISMISSED = 'papyra-demo-banner-dismissed';

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
      max-width: min(46rem, calc(100vw - 2rem));
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: var(--space-3, 12px);
      padding: var(--space-3, 12px) var(--space-4, 16px);
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
    }
    .demo-banner__text { margin: 0; }
    .demo-banner__text strong { color: var(--text-h); font-weight: 600; }
    .demo-banner__actions { display: flex; gap: var(--space-2, 8px); margin-left: auto; }
    .demo-banner button,
    .demo-banner a {
      padding: 6px 12px;
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
    @media (max-width: 40rem) {
      .demo-banner { border-radius: var(--radius-md, 12px); width: auto; }
      .demo-banner__actions { margin-left: 0; width: 100%; }
    }
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
  text.innerHTML =
    '<strong>This is a demo.</strong> Everything runs in your browser — nothing is sent anywhere.';

  const actions = document.createElement('div');
  actions.className = 'demo-banner__actions';

  const reset = document.createElement('button');
  reset.type = 'button';
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

  const close = document.createElement('button');
  close.type = 'button';
  close.textContent = 'Hide';
  close.setAttribute('aria-label', 'Hide the demo notice');
  close.addEventListener('click', () => {
    bar.remove();
    try {
      sessionStorage.setItem(DISMISSED, '1');
    } catch {
      /* private mode — it just comes back on the next page load */
    }
  });

  actions.append(reset, install, close);
  bar.append(dot, text, actions);

  try {
    if (sessionStorage.getItem(DISMISSED) === '1') return;
  } catch {
    /* storage unavailable — show it */
  }
  document.body.append(bar);
}
