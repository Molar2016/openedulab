-- 0002: placement-scoped personal parameter snapshots (ADR-003).
--
-- A curriculum placement is a directory entry that reuses one tool. Its personal snapshot
-- belongs to (account, placement) and must never be copied from, or into, the tool-level
-- row in `saved_state` — hence a separate table rather than a nullable column: the two
-- scopes cannot read each other even if a future query forgets a predicate.
--
-- `0001_init.sql` stays untouched (its checksum is recorded in `schema_migrations`).

CREATE TABLE IF NOT EXISTS placement_saved_state (
  account_id TEXT NOT NULL REFERENCES account (id) ON DELETE CASCADE,
  placement_id TEXT NOT NULL,
  experiment_id TEXT NOT NULL,
  placement_version INTEGER NOT NULL,
  content_version TEXT NOT NULL,
  state_schema_version INTEGER NOT NULL,
  payload TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (account_id, placement_id)
);

CREATE INDEX IF NOT EXISTS placement_saved_state_experiment
  ON placement_saved_state (experiment_id);
