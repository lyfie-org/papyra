-- One row per install — everything the project knows about it. `id` is a random UUID the install
-- made for itself; it is not derived from anything. There is no column for an IP address, a host
-- name, a user, or a note, and there never will be.
CREATE TABLE IF NOT EXISTS installs (
  id         TEXT PRIMARY KEY,
  first_seen TEXT NOT NULL,            -- yyyy-mm-dd (UTC), the first time it checked in
  last_seen  TEXT NOT NULL,            -- yyyy-mm-dd (UTC), the latest check-in
  version    TEXT NOT NULL,            -- the release it runs: 1.0.0, or 1.0.0-dev.abc1234 for a development build
  arch       TEXT NOT NULL,            -- processor family: x64, arm64, arm, other
  os         TEXT NOT NULL,            -- operating system family: linux, windows, macos, other
  country    TEXT NOT NULL,            -- two letters from the connection, or ZZ when unknown
  pings      INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS installs_last_seen ON installs (last_seen);

-- Two small remembered answers, so a bad day never blanks what people see:
--   latest — the newest release (GitHub is asked at most once an hour, and its last answer is kept)
--   stats  — the last public numbers that were worked out properly
CREATE TABLE IF NOT EXISTS meta (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL          -- unix seconds
);
