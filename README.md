<div align="center">
  <img src="assets/papyra_logo_bg.png" alt="Papyra Logo" width="120" />
  <h1>Papyra</h1>
  <p><strong>A calm, self-hosted home for your notes.</strong></p>
  <p>Your notes stay as ordinary Markdown files on your own server. Full-text search, wiki links and backlinks, offline editing, sharing, and passkey-locked vaults — in one container.</p>
  <p>
    <a href="https://papyra.app">Website</a> ·
    <a href="https://papyra.app/demo">Live demo</a> ·
    <a href="https://papyra.app/docs">Docs</a> ·
    <a href="https://hub.docker.com/r/lyfie/papyra">Docker Hub</a>
  </p>
</div>

---

> [!WARNING]
> **ACTIVE DEVELOPMENT** — v0.1.2. Anything can change and break anytime.
> If you adopt it today, keep the backups it makes for you.

---

### 📦 Quick start

```bash
curl -O https://raw.githubusercontent.com/lyfie-org/papyra/main/docker-compose.hub.yml
docker compose -f docker-compose.hub.yml up -d
```

Then open `http://localhost:8080` and create the first account. One container,
one volume — there is nothing else to stand up alongside it.
See [the install docs](https://papyra.app/docs/install) for HTTPS, reverse
proxies, and file ownership (`PUID`/`PGID`).

---

### 🧭 The idea

The filesystem is the source of truth. Every note is a `.md` file with YAML
frontmatter, sitting in a folder you own. SQLite and the Lucene index are
**disposable caches** — delete either one and Papyra rebuilds it from the files.
Nothing about your notes depends on Papyra continuing to exist.

That means Syncthing, Dropbox, git or Obsidian can edit the vault behind the
app's back. Papyra watches the folder, catches up, and surfaces sync-conflict
files instead of choking on them.

---

### 🛠️ The tech stack

#### Backend (`/papyra.api`)

| | |
|---|---|
| **Runtime** | .NET 10 Minimal APIs (C# 14), single `Program.cs` route registration |
| **Markdown & frontmatter** | `Markdig` 0.42 (`UseYamlFrontMatter`) + `YamlDotNet` 16.3 — unknown frontmatter keys are round-tripped untouched |
| **Full-text search** | `Lucene.Net` 4.8.0-beta00017 (+ Analysis.Common, QueryParser, Highlighter) |
| **Cache / metadata** | EF Core 10 + SQLite — rebuildable from the `.md` files, never the authority |
| **Real-time** | `FileSystemWatcher` (one per tenant) + SignalR for metadata-only push |
| **Auth** | Cookie sessions, BCrypt passwords, `Fido2.AspNet` passkeys, optional OIDC SSO |
| **Git sync** | `LibGit2Sharp` — per-user credentials, never force-pushes |
| **Docs** | OpenAPI + `Scalar.AspNetCore` |

Also shipped but **held back behind a feature flag**: local AI (Whisper
transcription, Tesseract OCR, Ollama embeddings and RAG chat). The routes return
404 and are excluded from OpenAPI until `PAPYRA_AI_ENABLED` is turned on.

#### Frontend (`/papyra.web`)

| | |
|---|---|
| **Framework** | React 19 / TypeScript 6 / Vite 8 |
| **Routing** | `react-router-dom` 7 |
| **Data fetching** | `@tanstack/react-query` 5 — no Redux, no Zustand |
| **Editor** | `@lyfie/luthor` 2.9.5 (our Lexical 0.40 wrapper). *Standard Lexical or alternative rich-text engines are not used here.* |
| **Real-time** | `@microsoft/signalr` |
| **Offline** | IndexedDB outbox + service worker; autosave, no save button |

#### Website (`/papyra.app`)

Astro 7 static site — marketing pages, ten docs pages, the rendered API
reference, and a **live in-browser demo** built from `papyra.web` with a fake
backend. Deployed to Cloudflare Pages from GitHub Actions.

---

### 📂 Repository structure

```text
papyra/
├── papyra.api/              # .NET 10 Minimal API + xUnit and edge tests
│   ├── src/Papyra.Api/      # Program.cs (all routes), Storage/, Security/, Hubs/, Features/
│   └── tests/
│       ├── Papyra.Tests/    # 47 xUnit classes
│       └── edge/            # Black-box HTTP harness against a running instance
├── papyra.web/              # Vite + React 19 app (also built in demo mode)
├── papyra.app/              # Astro marketing site + docs + demo host
├── data/                    # Git-ignored local dev storage volume (see below)
├── Dockerfile               # 4-stage, multi-arch (amd64 + arm64)
├── docker-compose.hub.yml   # The self-hosting file — pulls lyfie/papyra:latest
└── pnpm-workspace.yaml      # papyra.web + papyra.app
```

#### What lives in the data volume

```text
data/
├── users/{userId}/
│   ├── notes/               # ← the source of truth: your .md files
│   ├── media/               # attachments referenced as ![[filename]]
│   ├── .trash/              # soft-deleted items, kept until retention expires
│   └── .papyra/             # UI state: snapshots/, order.json, categories.json, avatar
└── .papyra/
    ├── papyra.db            # SQLite cache — rebuildable
    ├── lucene-index/        # full-text index — rebuildable
    └── keys/                # Data Protection key ring — NOT disposable
```

Papyra-owned state is always in a hidden `.papyra/` directory, never inside the
notes folder, so a sync client or file watcher never sees it churn.

---

### 🧪 Development

```bash
# Everything at once (API :5220 + web :5173)
pnpm install && pnpm dev

# Backend
dotnet build Papyra.slnx
dotnet test papyra.api/tests/Papyra.Tests/Papyra.Tests.csproj

# Frontend (from papyra.web/)
pnpm run build            # type-check + production bundle

# Docker, from source
docker compose up --build # → :8080
```

#### Tests

| Suite | What it is | Count |
|---|---|---|
| `papyra.api/tests/Papyra.Tests` | xUnit — storage, path jail, search index, conflict detection, cold-boot diff, auth, sharing, backups | **373 test cases** across 47 classes |
| `papyra.api/tests/edge` | Black-box HTTP checks against a running instance — routing, auth policies, cookies, tenant isolation, real status codes | **239 checks** (`edge.sh` 99 + `edge2.sh` 140) |

The edge harness needs a live instance and a throwaway vault; see
[`papyra.api/tests/edge/README.md`](papyra.api/tests/edge/README.md).
Its AI-surface checks currently fail by design, because the assistant is
flag-gated off.

---

### 📄 License

[GNU GPL v3.0](LICENSE). Contributions welcome — open an issue first for
anything large.
