<div align="center">
  <img src="assets/papyra_logo_bg.png" alt="Papyra Logo" width="120" />
  <h1>Papyra</h1>
  <p><strong>Self-hosted, production-grade, zero-database note-taking suite designed with care.</strong></p>
  <p>Balancing blazing-fast local performance with bulletproof synchronization, entirely tolerant to external filesystem modifications.</p>
</div>

---

> [!WARNING]
> **ACTIVE DEVELOPMENT**
> Anything can change and break anytime.

---

### 🛠️ The Tech Stack

#### Backend (`/papyra.api`)
* **Runtime & Framework:** .NET 10 Minimal APIs (C# 13)
* **Markdown Engine:** `Markdig` (handles strict YAML frontmatter separation)
* **Real-time Synchronization:** `FileSystemWatcher` coupled with `Microsoft.AspNetCore.SignalR` for instant UI push updates upon disk mutation.
* **Full-Text Search Engine:** `Lucene.Net (v4.8.0-beta)` for high-performance text indexing and querying.

#### Frontend (`/papyra.web`)
* **Framework & Build Tool:** React 19 / TypeScript / Vite
* **Routing:** `react-router-dom` (Home, Settings, Admin)
* **State Management & Data Fetching:** `@tanstack/react-query` (configured for immediate, optimistic UI updates)
* **Rich Text Editor:** `@lyfie/luthor` (Our custom Lexical wrapper. *Note: Standard Lexical or alternative rich-text engines are strictly forbidden*).
* **Workspace Engine:** `pnpm workspaces` using `concurrently` to orchestrate multi-tier local development.

---

### 📂 Repository Structure

```text
papyra/
├── papyra.api/          # .NET 10 Minimal API Solution & xUnit Tests
│   └── src/
│       └── Papyra.Api/  # Backend entry points, Hubs, Controllers
├── papyra.web/          # Vite + React 19 Frontend Application
├── data/                # Git-ignored local development storage volume
│   ├── notes/           # Target folder containing raw .md files
│   └── images/          # Target folder for media attachments & uploads
├── package.json         # Monorepo orchestration scripts
└── pnpm-workspace.yaml  # Workspace configuration
```