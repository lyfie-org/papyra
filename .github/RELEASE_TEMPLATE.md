<!--
  Papyra release notes template.
  Copy everything below the line into the GitHub release body.
  Delete any section that has nothing in it. Keep it short: what changed for
  the person using Papyra, not how it was built.
-->

---

# vX.Y.Z

One or two lines in my own words: what this release is about and why you'd want it.

## ⚠️ Breaking changes

> Read this before you pull the new image.

- What changed, who it affects, and what to do about it.

## 🌟 Highlights

### Feature name
A sentence or two on what you can do now. Add a screenshot if it helps.

### Another feature
…

## 🚀 New features
- …

## ✨ Improvements
- …

## 🐛 Bug fixes
- …

## 🔒 Security
- …

## 🧰 For self-hosters
- New/changed environment variables, volumes, ports, or migrations.
- `PAPYRA_SOMETHING` — what it does, default.

## 📦 Upgrade

```bash
docker compose pull && docker compose up -d
```

Image: `lyfie/papyra:vX.Y.Z` (also `latest`). Back up your data volume before a major or breaking release.

## 📝 Commits
- feat: … (abc1234)
- fix: … (def5678)

**Full changelog:** https://github.com/lyfie-org/papyra/compare/vPREV...vX.Y.Z
