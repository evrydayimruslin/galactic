-- Phase 2: the inference envelope, operator settings, and the label taxonomy.
--
-- settings: small per-user preference store (operator language, etc.), managed
-- through the set_language/get_language functions rather than env vars so it is
-- changeable at the same level as any other function call.
CREATE TABLE IF NOT EXISTS settings (
  user_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL DEFAULT '',
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_settings_user ON settings(user_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_settings_user_key ON settings(user_id, key);

-- labels: the user-editable taxonomy the AI assigns from. Seeded with defaults
-- (classification mirrors + no-reply reasons) in app code on first use — a
-- migration cannot seed per-user rows. Per-user by construction: the platform
-- injects user_id on every query, so the API can only ever fetch the caller's
-- own labels.
CREATE TABLE IF NOT EXISTS labels (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  key TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT 'general',
  built_in INTEGER NOT NULL DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_labels_user ON labels(user_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_labels_user_key ON labels(user_id, key);

-- conversation_labels: many-to-many assignment (a conversation carries several
-- labels), join-table shape so label filtering is an index scan rather than a
-- LIKE over a delimited column (D1's LIKE has a pattern-complexity limit this
-- app has already hit once).
CREATE TABLE IF NOT EXISTS conversation_labels (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  label_key TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_conversation_labels_user ON conversation_labels(user_id);
CREATE INDEX IF NOT EXISTS idx_conversation_labels_convo ON conversation_labels(user_id, conversation_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_conversation_labels_unique ON conversation_labels(user_id, conversation_id, label_key);

-- Envelope denormalization onto conversations for list-level display and
-- filtering: the latest inbound's thorough summary, the latest draft's
-- confidence grade, and the no-reply reason when the agent decided a reply
-- would be wrong or redundant. Full per-message envelope details live on the
-- version rows' metadata.
ALTER TABLE conversations ADD COLUMN summary TEXT DEFAULT '';
ALTER TABLE conversations ADD COLUMN confidence TEXT DEFAULT '';
ALTER TABLE conversations ADD COLUMN no_reply_reason TEXT DEFAULT '';
