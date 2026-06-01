# syntax=docker/dockerfile:1.7
# Multi-arch build (linux/amd64 + linux/arm64):
#   docker buildx build --platform linux/amd64,linux/arm64 -t you/papyra:latest --push .

FROM --platform=$BUILDPLATFORM node:22-alpine AS frontend
WORKDIR /build
COPY papyra.web/package.json papyra.web/package-lock.json ./
RUN npm ci --prefer-offline
COPY papyra.web/ ./
RUN npm run build

FROM --platform=$BUILDPLATFORM mcr.microsoft.com/dotnet/sdk:10.0 AS api
WORKDIR /build
COPY papyra.api/ ./
RUN dotnet publish src/Papyra.Api/Papyra.Api.csproj \
      --configuration Release \
      --output /publish \
      --no-self-contained

FROM mcr.microsoft.com/dotnet/aspnet:10.0 AS runtime
WORKDIR /app

COPY --from=api      /publish    .
COPY --from=frontend /build/dist ./wwwroot

VOLUME ["/data"]

ENV ASPNETCORE_URLS="http://+:8080" \
    ASPNETCORE_ENVIRONMENT="Production" \
    DOTNET_SYSTEM_GLOBALIZATION_INVARIANT=false

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD curl -sf http://localhost:8080/health || exit 1

ENTRYPOINT ["dotnet", "Papyra.Api.dll"]
