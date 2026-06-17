#!/bin/sh
# Papyra container entrypoint — self-hoster permission matrix.
#
# Reads PUID/PGID (default 1000) so notes written to the /data volume are owned
# by the host user, not root. Without this, files created in-container land as
# root:root and the host user can't edit them over SMB/Syncthing/etc.
#
# Flow: ensure a `papyra` group/user with the requested ids exist → chown the
# data volume → drop privileges with su-exec before launching the API.
set -e

PUID="${PUID:-1000}"
PGID="${PGID:-1000}"
DATA_DIR="${PAPYRA_DATA_DIR:-/data}"

echo "[entrypoint] starting Papyra as PUID=${PUID} PGID=${PGID} (data=${DATA_DIR})"

# ── Group: reuse one already holding PGID, else create/realign `papyra` ───────
existing_group="$(getent group "${PGID}" | cut -d: -f1)"
if [ -n "${existing_group}" ]; then
    GROUP_NAME="${existing_group}"
else
    if getent group papyra >/dev/null 2>&1; then
        groupmod -g "${PGID}" papyra
    else
        addgroup -g "${PGID}" papyra
    fi
    GROUP_NAME="papyra"
fi

# ── User: reuse one already holding PUID, else create/realign `papyra` ────────
existing_user="$(getent passwd "${PUID}" | cut -d: -f1)"
if [ -n "${existing_user}" ]; then
    USER_NAME="${existing_user}"
else
    if getent passwd papyra >/dev/null 2>&1; then
        usermod -u "${PUID}" -g "${PGID}" papyra
    else
        adduser -D -H -u "${PUID}" -G "${GROUP_NAME}" papyra
    fi
    USER_NAME="papyra"
fi

# ── Own the data volume so the dropped-privilege user can read/write ──────────
mkdir -p "${DATA_DIR}"
chown -R "${PUID}:${PGID}" "${DATA_DIR}"

echo "[entrypoint] dropping privileges to ${USER_NAME}:${GROUP_NAME}, launching API"
exec su-exec "${PUID}:${PGID}" dotnet Papyra.Api.dll "$@"
