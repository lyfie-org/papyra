-- For a database made from the earlier schema.sql (before check-in hours and day counts). A new database
-- doesn't need this: schema.sql already has the columns. Run once:
--   npx wrangler d1 execute papyra-versions --remote --file=migrate-2026-10-30.sql
ALTER TABLE installs ADD COLUMN first_hour INTEGER NOT NULL DEFAULT 0;
ALTER TABLE installs ADD COLUMN last_hour INTEGER NOT NULL DEFAULT 0;
ALTER TABLE installs ADD COLUMN days INTEGER NOT NULL DEFAULT 1;

-- The best that can be said about rows that were counted by date alone: noon on those days, and no more
-- days than there were check-ins.
UPDATE installs SET
  first_hour = CAST(unixepoch(first_seen) / 3600 AS INTEGER) + 12,
  last_hour  = CAST(unixepoch(last_seen)  / 3600 AS INTEGER) + 12,
  days       = MAX(1, MIN(pings, CAST(julianday(last_seen) - julianday(first_seen) AS INTEGER) + 1));

CREATE INDEX IF NOT EXISTS installs_first_hour ON installs (first_hour);
