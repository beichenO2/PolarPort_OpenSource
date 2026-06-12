CREATE TABLE IF NOT EXISTS preferred_reservations (
  service_name   TEXT NOT NULL,
  project        TEXT NOT NULL,
  preferred_port INTEGER NOT NULL,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(service_name, project)
);
CREATE INDEX IF NOT EXISTS idx_preferred_reservations_port ON preferred_reservations(preferred_port);
