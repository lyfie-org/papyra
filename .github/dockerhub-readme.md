# Papyra

A self-hosted notes app with Keep-style cards. Every note is a plain Markdown file with YAML frontmatter in a folder you own. The database and search index are caches that can be rebuilt from the files.

Website and live demo: https://papyra.app · Source: https://github.com/lyfie-org/papyra · License: GPL-3.0

![Searching notes](https://raw.githubusercontent.com/lyfie-org/papyra/main/assets/readme/search.gif)

## Run it

One container, one volume, amd64 and arm64.

```bash
curl -O https://raw.githubusercontent.com/lyfie-org/papyra/main/docker-compose.hub.yml
docker compose -f docker-compose.hub.yml up -d
```

Then open http://localhost:8080. The first account you create is the administrator. Full install guide: https://papyra.app/docs/install/

Update:

```bash
docker compose -f docker-compose.hub.yml pull
docker compose -f docker-compose.hub.yml up -d
```

## What it does

- Notes are `.md` files on disk. Stop using Papyra and you still have a folder of Markdown.
- Wikilinks and backlinks, tags, collections, to-do lists, full-text search, version history.
- Live editing on shared notes, with comments and @mentions.
- Locked notes encrypted at rest, a daily journal, passkeys, TOTP and OIDC sign-in.
- REST API with API keys, signed webhooks, Git backup, zip export.
- Imports Google Keep (Takeout), Obsidian and Day One. Any `.md` file can be dragged in.
- Installable PWA that works offline.

![Live editing](https://raw.githubusercontent.com/lyfie-org/papyra/main/assets/readme/collab.gif)

## Tags

- `latest`: the newest release.
- `vX.Y.Z`: a specific release.
- `dev`: the development branch, may break.

## Privacy

No analytics, no crash reports, no third-party requests. The server makes one outbound call, a daily check for updates, which I also use as a count of installs. Set `PAPYRA_UPDATE_CHECK_ENABLED=false` to turn it off. What it sends: https://papyra.app/docs/update-check

Parts of Papyra are written with AI coding assistants; I review and test what ships.
