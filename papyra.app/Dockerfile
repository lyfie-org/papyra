# syntax=docker/dockerfile:1.7
# The Papyra website (papyra.app) as a self-contained image, for checking changes
# before they are pushed. Same build as CI (.github/workflows/site.yml): the
# in-browser demo is built first, then the site, then nginx serves dist/.
#
# The build context is the REPOSITORY ROOT (the site reads CHANGELOG.md,
# CONTRIBUTING.md and papyra.web's tokens.css), so build from there:
#
#   docker build -f papyra.app/Dockerfile -t papyra-site:local .
#   docker run --rm -p 4321:80 papyra-site:local        # → http://localhost:4321
#
# or: docker compose -f papyra.app/docker-compose.yml up --build
#
# Move it to another machine with:
#   docker save papyra-site:local | gzip > papyra-site.tar.gz
#   gunzip -c papyra-site.tar.gz | docker load

# ─── Stage 1: Node — build the demo and the site ─────────────────────────────
FROM node:22-alpine AS build

RUN corepack enable && corepack prepare pnpm@11.5.1 --activate

WORKDIR /build

# Manifests first, so a source-only change reuses the installed dependencies.
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY papyra.web/package.json papyra.web/
COPY papyra.app/package.json papyra.app/
COPY papyra.collab/package.json papyra.collab/

RUN pnpm install --frozen-lockfile --filter papyra-app... --filter papyra-web...

COPY VERSION CHANGELOG.md CONTRIBUTING.md ./
COPY papyra.web/ papyra.web/
COPY papyra.app/ papyra.app/

# "dev" adds the dev-preview banner, noindex and a blocking robots.txt; empty
# builds the production site. For checking a change, the default is fine.
ARG PUBLIC_SITE_CHANNEL=""
ENV PUBLIC_SITE_CHANNEL=$PUBLIC_SITE_CHANNEL

# The demo writes into papyra.app/public/demo, which the site then copies into dist/.
RUN pnpm --filter papyra-web run build:demo
RUN pnpm --filter papyra-app run build

# ─── Stage 2: nginx — serve the static files ─────────────────────────────────
FROM nginx:1.27-alpine

COPY papyra.app/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /build/papyra.app/dist/ /usr/share/nginx/html/

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1/ >/dev/null || exit 1
