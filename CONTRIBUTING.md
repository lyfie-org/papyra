# Contributing to Papyra

Thanks for wanting to help. Papyra is young, so every bug report, idea and pull
request genuinely shapes it.

## Ways to help — no code needed

- **Use it and tell us what breaks.** Try the [live demo](https://papyra.app/demo/)
  or run your own copy, then [open an issue](https://github.com/lyfie-org/papyra/issues/new)
  with what you did, what you expected and what happened. Screenshots help.
- **Ask for what's missing.** Feature ideas are issues too. Say what you are trying
  to do, not only the button you want.
- **Improve the docs.** Anything that confused you on [papyra.app/docs](https://papyra.app/docs/)
  will confuse the next person. The pages live in `papyra.app/src/content/docs/`.
- **Star the repo and tell a friend.** Honestly, this helps more than you'd think.

Found a security problem? Please don't open a public issue — report it privately
through [GitHub's security advisories](https://github.com/lyfie-org/papyra/security/advisories/new).

## Building on Papyra

Want to script your notes, connect another tool or build a plugin? Everything
the web app does goes through a documented REST API, with personal API keys and
signed webhooks: see the [API reference](https://papyra.app/api/).

## Before you write code

For anything bigger than a small fix, **open an issue first** so we can agree on
the approach before you spend an evening on it.

Papyra was largely vibe-coded with AI assistants, so AI-assisted pull requests are
welcome. The bar is the same either way: you have read the change, run it, and
tested it.

## Setting up

You need the [.NET 10 SDK](https://dotnet.microsoft.com/download), Node 22 and
pnpm 11.

```bash
git clone https://github.com/lyfie-org/papyra.git
cd papyra
pnpm install
pnpm dev        # API on :5220, web app on :5173, live-editing engine on :5231
```

| Folder | What it is |
|---|---|
| `papyra.api/` | .NET 10 Minimal API, plus xUnit and black-box edge tests |
| `papyra.web/` | The React 19 + Vite web app (also built as the in-browser demo) |
| `papyra.collab/` | The live-editing engine, run by the API as a child process |
| `papyra.app/` | This website: Astro, docs and the demo host |

## A few rules the code lives by

- **The `.md` files are the source of truth.** SQLite and the search index are
  caches that can be rebuilt from the folder. Never make them the only copy of
  anything.
- **Writes are atomic** — temp file, flush, replace. A crash must never leave half
  a note.
- **Papyra's own state lives in `.papyra/`**, never inside the notes folder.
- **Never move someone's caret.** A remote change must not hijack the editor.
- **Design tokens only.** Colours come from `var(--token)`; fonts are Marcellus,
  Sora and Roboto Mono; everything meets WCAG AA in light and dark.

## Before you open a pull request

Run the checks for whatever you touched:

```bash
# API
dotnet build Papyra.slnx
dotnet test papyra.api/tests/Papyra.Tests/Papyra.Tests.csproj

# Web app (from papyra.web/)
pnpm run build          # type-check + bundle — catches more than tsc --noEmit
pnpm test
pnpm run check:a11y     # WCAG 2.2 AA in real Chromium (CI fails on any violation)

# Live-editing engine (from papyra.collab/)
pnpm run typecheck && pnpm run lint && pnpm test

# Website (from papyra.app/)
pnpm run build
```

Then:

1. Branch from **`development`** and open your pull request against
   **`development`** — `main` only receives releases.
2. Use [Conventional Commit](https://www.conventionalcommits.org) prefixes
   (`feat:`, `fix:`, `docs:`, `chore:`…). The changelog is generated from them.
3. Keep it focused: one change per pull request, with a sentence on *why*.
4. If it changes what a user sees, include a screenshot.

## Part of Lyfie

Papyra is a [Lyfie](https://www.lyfie.org) project, alongside its editor,
[luthor](https://www.luthor.fyi). Other projects that could use a hand are listed at
[lyfie.org/contribute](https://www.lyfie.org/contribute/).

## License

Papyra is [GPL-3.0](https://github.com/lyfie-org/papyra/blob/main/LICENSE). By
contributing, you agree your work is released under the same license.
