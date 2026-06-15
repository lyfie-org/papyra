# syntax=docker/dockerfile:1.7
# Multi-arch build (linux/amd64 + linux/arm64):
#   docker buildx build --platform linux/amd64,linux/arm64 -t lyfie/papyra:latest --push .

# ─── Stage 1: Node — build frontend ──────────────────────────────────────────
FROM --platform=$BUILDPLATFORM node:22-alpine AS frontend

RUN corepack enable && corepack prepare pnpm@11.5.1 --activate

WORKDIR /build

# Copy manifests first for layer-cache efficiency
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY papyra.web/package.json papyra.web/

RUN pnpm install --frozen-lockfile

COPY papyra.web/ papyra.web/

RUN pnpm --filter ./papyra.web build

# ─── Stage 2: .NET — restore ──────────────────────────────────────────────────
FROM --platform=$BUILDPLATFORM mcr.microsoft.com/dotnet/sdk:10.0 AS dotnet-restore

WORKDIR /src

COPY papyra.api/ papyra.api/

RUN dotnet restore papyra.api/src/Papyra.Api/Papyra.Api.csproj

# ─── Stage 3: .NET — publish (inject SPA assets) ─────────────────────────────
FROM dotnet-restore AS dotnet-publish

# Embed frontend dist into wwwroot so StaticFiles serves the SPA without a CDN
COPY --from=frontend /build/papyra.web/dist papyra.api/src/Papyra.Api/wwwroot/

RUN dotnet publish papyra.api/src/Papyra.Api/Papyra.Api.csproj \
      -c Release \
      -o /app/publish \
      --no-restore

# ─── Stage 4: Runtime ─────────────────────────────────────────────────────────
FROM mcr.microsoft.com/dotnet/aspnet:10.0-alpine AS runtime

RUN apk add --no-cache icu-libs
ENV DOTNET_SYSTEM_GLOBALIZATION_INVARIANT=false

WORKDIR /app

COPY --from=dotnet-publish /app/publish ./

ENV ASPNETCORE_URLS="http://+:8080" \
    ASPNETCORE_ENVIRONMENT="Production" \
    DOTNET_SYSTEM_GLOBALIZATION_INVARIANT=false

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD wget -qO- http://localhost:8080/health || exit 1

ENTRYPOINT ["dotnet", "Papyra.Api.dll"]
