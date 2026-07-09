-- Interface support: list-level envelope denormalization + activity + gap ledgers.
--
-- conversations gains the envelope's priority and recipient proposal so the
-- interface list view can show urgency dots and the default reply-to without
-- opening each thread's version metadata (rows stay body-free).
ALTER TABLE conversations ADD COLUMN priority TEXT DEFAULT '';
ALTER TABLE conversations ADD COLUMN recipient_default TEXT DEFAULT '';
ALTER TABLE conversations ADD COLUMN recipient_reason TEXT DEFAULT '';

-- check_log: one row per mailbox poll (success or failure), so the interface
-- can answer "when did the agent last look, and how often today?" without
-- inferring it from conversation timestamps. Pruned to ~8 days in app code.
CREATE TABLE IF NOT EXISTS check_log (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  ts TEXT NOT NULL,
  new_emails INTEGER DEFAULT 0,
  ok INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_check_log_user ON check_log(user_id);
CREATE INDEX IF NOT EXISTS idx_check_log_user_ts ON check_log(user_id, ts);

-- gap_ledger: knowledge gaps the operator has resolved — dismissed as noise or
-- answered by teaching a convention. Gaps are mined live from version metadata;
-- this ledger only records which normalized keys to stop surfacing (state =
-- 'dismissed' | 'answered', convention_key set when a convention answered it).
CREATE TABLE IF NOT EXISTS gap_ledger (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  gap_key TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'dismissed',
  convention_key TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_gap_ledger_user ON gap_ledger(user_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_gap_ledger_user_key ON gap_ledger(user_id, gap_key);
