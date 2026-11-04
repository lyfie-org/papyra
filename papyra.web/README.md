# papyra.web

The Papyra web app: React 19, TypeScript and Vite, with the editor from
[`@lyfie/luthor`](https://www.luthor.fyi). The API serves the built bundle in
production. The same code is also built in **demo mode** for the live demo at
[papyra.app/demo](https://papyra.app/demo), against a fake in-browser backend.

## Run it

From the repository root, `pnpm install && pnpm dev` starts this app with the
API and the live-editing engine (ports in the root [README](../README.md)).
`pnpm dev` here starts only this app and expects the API to be running.

## Checks

```bash
pnpm run build          # tsc -b + production bundle
pnpm run build:demo     # the same, in demo mode
pnpm run lint
pnpm test               # vitest
pnpm run check:a11y     # axe-core, WCAG 2.2 AA, in real Chromium
pnpm run check:editor   # editor and media end to end, plus performance budgets
```

`check:a11y` runs against the in-browser demo, and `check:editor` starts its own
throwaway API, so neither touches your data. Rules the code lives by are in
[`CONTRIBUTING.md`](../CONTRIBUTING.md).
