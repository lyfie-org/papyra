# Release lines: dev and prod

Papyra has two lines, for both the Docker image and the website.

| | **Prod** (from `main`) | **Dev** (from `development`) |
|---|---|---|
| Image | `lyfie/papyra:vX.Y.Z`, `:latest` | `lyfie/papyra:dev` |
| Image workflow | `release.yml` (by hand) | `docker-dev.yml` (by hand) |
| Website | https://papyra.app | https://dev.papyra.app (noindex) |
| Site workflow | `site.yml`: push to main, daily, or by hand | `site.yml`: push to `development` (when site or web files change), or by hand |

The dev line never writes `latest` or a version tag, and never commits or tags
in git. Running it has no effect on the next release.

## Try a dev build

1. **Actions → Docker (dev) → Run workflow**, branch `development`. It builds the
   image, smoke-tests it (boots, `/health`, live collaboration), then pushes
   `dev` for amd64 and arm64. On any other branch the job
   is skipped.
2. **The dev site deploys itself** whenever you push to `development` and something it
   is built from changed (`papyra.app/**`, `papyra.web/**` and the other paths listed in
   `site.yml`). To redeploy without a change: **Actions → site → Run workflow**, branch
   `development`. It builds with `PUBLIC_SITE_CHANNEL=dev` and deploys to the `development`
   branch of the Cloudflare Pages project `papyra`, which `dev.papyra.app` serves.
3. Run the dev image:

   ```bash
   PAPYRA_TAG=dev docker compose -f docker-compose.hub.yml up -d
   ```

   Leave `PAPYRA_TAG` unset to go back to `latest`.

## What version the app shows

Every build names itself exactly, in the sidebar, Settings → About and error reports:

| Build | Shows as |
|---|---|
| Release (`release.yml`) | `v1.1.0` (the `VERSION` file, bumped before the final image build) |
| Dev image (`docker-dev.yml`) | `v1.0.0-dev.abc1234`: the last release plus the commit it was built from |
| Dev site demo (`site.yml` on `development`) | the same `-dev.<shortsha>` form |
| Local `pnpm dev` | `dev build` |

The pipeline passes `PAPYRA_BUILD_VERSION` (a Docker build arg for the image, an env var for
the demo); `papyra.web/vite.config.ts` bakes it into the bundle and `/version.json`, and falls
back to `VERSION` when it is unset. An open tab compares the two strings, so a newer dev image
asks for a reload just as a new release does.

Pushing to `development` redeploys the dev site (if site or web files changed) but does
not build an image: `docker-dev.yml` still runs only when you start it. CI (`ci.yml`)
still runs on every push.

## Ship to prod

Merge `development` into `main`. The push redeploys papyra.app. Then run
**Actions → Release** on `main` to publish `vX.Y.Z` and `latest`, the GitHub
Release, and a fresh site build.

## How the dev site differs

All of this happens only when `PUBLIC_SITE_CHANNEL=dev`. A local `pnpm run build`
is production.

- Every page has `<meta name="robots" content="noindex, nofollow">`.
- `_headers` adds `X-Robots-Tag: noindex, nofollow` on `/*`, which also covers
  `/demo` and the plain-text twins.
- `robots.txt` is `Disallow: /`, and no sitemap is built.
- Canonical URLs still point at papyra.app, so the dev site never competes with it.
- A banner on every page names the `lyfie/papyra:dev` image and links back to papyra.app.
- `/demo` is the demo built from `development`.

Code: `IS_DEV_SITE` in `papyra.app/src/data/site.ts`, `Base.astro`,
`components/DevBanner.astro`, `scripts/channel.mjs`, and `astro.config.mjs`
(sitemap). `site.yml` checks the noindex markers before it deploys a dev build.

## One-time setup

- **DNS / Pages**: in Cloudflare Pages, open project `papyra`, go to
  **Custom domains**, and add `dev.papyra.app`. Then, in the papyra.app DNS
  zone, set the `dev` CNAME to `development.papyra.pages.dev` instead of
  `papyra.pages.dev`. That ties the domain to the `development` branch rather
  than to production.
- **Secrets**: none new. The workflows reuse `DOCKERHUB_USERNAME`,
  `DOCKERHUB_TOKEN`, `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.
- **Docker Hub**: nothing to set up. The `dev` tag appears on the first push and
  is overwritten by each later one, so nothing piles up.
