-- 0001_init: platform schema from docs/architecture/A-stage-design.md §5.
--
-- Portable subset only (§8.4): TEXT/INTEGER columns, PRIMARY KEY, UNIQUE, CHECK,
-- FOREIGN KEY ... ON DELETE CASCADE, CREATE INDEX IF NOT EXISTS. No AUTOINCREMENT,
-- no partial indexes, no triggers, no PRAGMA statements, no dates via SQL functions.
--
-- Conventions: ids are application-generated UUIDv4 TEXT; timestamps are INTEGER
-- Unix milliseconds UTC; booleans are INTEGER 0/1; enums are CHECKed TEXT.
--
-- These tables are created here but stay unused until B2 (auth) and B4/B5 (personal
-- data, diagnostics). Creating them now fixes the migration baseline; changes must
-- arrive as new forward-only migrations, never by editing this file.

CREATE TABLE IF NOT EXISTS account (
  id TEXT PRIMARY KEY,
  login_kind TEXT NOT NULL CHECK (login_kind IN ('email', 'phone')),
  normalized_login TEXT NOT NULL,
  display_hint TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  verified_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_account_login ON account (login_kind, normalized_login);

CREATE TABLE IF NOT EXISTS session (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES account (id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_session_token ON session (token_hash);
CREATE INDEX IF NOT EXISTS ix_session_account ON session (account_id);
CREATE INDEX IF NOT EXISTS ix_session_expires ON session (expires_at);

CREATE TABLE IF NOT EXISTS favorite (
  account_id TEXT NOT NULL REFERENCES account (id) ON DELETE CASCADE,
  experiment_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (account_id, experiment_id)
);

CREATE INDEX IF NOT EXISTS ix_favorite_created ON favorite (account_id, created_at);

CREATE TABLE IF NOT EXISTS recent_use (
  account_id TEXT NOT NULL REFERENCES account (id) ON DELETE CASCADE,
  experiment_id TEXT NOT NULL,
  last_opened_at INTEGER NOT NULL,
  PRIMARY KEY (account_id, experiment_id)
);

CREATE INDEX IF NOT EXISTS ix_recent_use_opened ON recent_use (account_id, last_opened_at);

CREATE TABLE IF NOT EXISTS saved_state (
  account_id TEXT NOT NULL REFERENCES account (id) ON DELETE CASCADE,
  experiment_id TEXT NOT NULL,
  content_version TEXT NOT NULL,
  state_schema_version INTEGER NOT NULL,
  payload TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (account_id, experiment_id)
);

CREATE TABLE IF NOT EXISTS event (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES account (id) ON DELETE CASCADE,
  experiment_id TEXT NOT NULL,
  content_version TEXT NOT NULL,
  app_version TEXT NOT NULL,
  locale TEXT NOT NULL CHECK (locale IN ('zh-CN', 'en')),
  event_type TEXT NOT NULL CHECK (event_type IN (
    'experiment_open',
    'experiment_first_interaction',
    'experiment_control_used',
    'experiment_reset',
    'experiment_fullscreen',
    'client_error',
    'feedback_submitted'
  )),
  control_group TEXT NOT NULL DEFAULT '',
  interaction_bucket TEXT NOT NULL DEFAULT '',
  error_code TEXT NOT NULL DEFAULT '',
  issue_category TEXT NOT NULL DEFAULT '',
  device_class TEXT NOT NULL DEFAULT 'unknown' CHECK (device_class IN ('desktop', 'mobile', 'tablet', 'unknown')),
  visit_id TEXT NOT NULL,
  client_event_id TEXT NOT NULL,
  dedupe_key TEXT,
  occurred_at_min INTEGER NOT NULL,
  received_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_event_client_event ON event (account_id, client_event_id);
CREATE UNIQUE INDEX IF NOT EXISTS ux_event_dedupe ON event (account_id, dedupe_key);
CREATE INDEX IF NOT EXISTS ix_event_experiment_time ON event (experiment_id, occurred_at_min);
CREATE INDEX IF NOT EXISTS ix_event_account_time ON event (account_id, occurred_at_min);
CREATE INDEX IF NOT EXISTS ix_event_type_time ON event (event_type, occurred_at_min);

CREATE TABLE IF NOT EXISTS feedback (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES account (id) ON DELETE CASCADE,
  experiment_id TEXT NOT NULL,
  content_version TEXT NOT NULL,
  app_version TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('bug', 'confusing', 'content', 'wrong_value', 'other')),
  message TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS ix_feedback_created ON feedback (created_at);

CREATE TABLE IF NOT EXISTS internal_audit (
  id TEXT PRIMARY KEY,
  operator_label TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('overview', 'account_timeline', 'export_events', 'export_feedback')),
  target_type TEXT NOT NULL DEFAULT '',
  target_id TEXT NOT NULL DEFAULT '',
  reason TEXT NOT NULL,
  row_count INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS ix_internal_audit_created ON internal_audit (created_at);
