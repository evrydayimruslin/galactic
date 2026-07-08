-- At-least-once ingestion support.
--
-- processed_messages: a per-user ledger of inbound Message-IDs the agent has
-- already turned into a conversation/version. The IMAP poller advances its UID
-- watermark only over a contiguous prefix of successfully-processed messages, so
-- normal operation never reprocesses; this ledger makes a crash-replay (a crash
-- between processing a message and persisting the watermark) idempotent — the
-- replayed message is recognized and skipped instead of drafted twice.
CREATE TABLE IF NOT EXISTS processed_messages (
  user_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  uid INTEGER,
  conversation_id TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_processed_messages_user ON processed_messages(user_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_processed_messages_mid ON processed_messages(user_id, message_id);

-- Track UIDVALIDITY alongside the UID watermark. When the mailbox reports a new
-- UIDVALIDITY (rebuilt/migrated mailbox), the old watermark is meaningless and
-- the poller re-baselines to the current tip instead of reprocessing the archive.
ALTER TABLE imap_sync_state ADD COLUMN uid_validity INTEGER DEFAULT 0;
