# Release notes

Every release has one file: [`.github/release-notes/vX.Y.Z.md`](release-notes/).
That file **is** the GitHub release body.

1. **Release** workflow runs → if `vX.Y.Z.md` already exists it is used as-is;
   otherwise a draft is generated from the `feat:` / `fix:` commit subjects and
   committed alongside `VERSION`.
2. Rewrite the draft in plain words (format below) and get it onto `main`.
3. **Release notes** workflow runs on that push (or run it by hand with a tag,
   or empty for every file) and copies the file into the GitHub release.

Keep it short and user-facing — what changed for the person using Papyra, not
how it was built. One line per bullet. Drop any section with nothing in it.

---

```markdown
One plain line: what this release is about.

### ⚠️ Breaking changes
- What changed and what to do before pulling.

### 🌟 Highlights
- **Feature.** A sentence on what you can do now.

### 🚀 Features
- …

### ✨ Improvements
- …

### 🐛 Fixes
- …

### 🔒 Security
- …

### 🧰 Self-hosting
- New env vars, volumes, migrations — `PAPYRA_SOMETHING`: what it does.

**Upgrade:** `docker compose pull && docker compose up -d` · **Full changelog:** [vPREV...vX.Y.Z](https://github.com/lyfie-org/papyra/compare/vPREV...vX.Y.Z)
```

Use **Highlights** only for a headline feature (one or two per release, max).
A one-fix release is just the summary line and a `### 🐛 Fixes` list.
