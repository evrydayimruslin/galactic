-- Galactic Canon — durable institutional decisions for connected agents.
-- Every table is automatically scoped by Galactic to the current user.

CREATE TABLE decisions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  title TEXT NOT NULL,
  statement TEXT NOT NULL,
  rationale TEXT NOT NULL DEFAULT '',
  alternatives TEXT NOT NULL DEFAULT '',
  consequences TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'superseded', 'archived')),
  decided_at TEXT NOT NULL,
  effective_at TEXT,
  last_reviewed_at TEXT,
  review_due_at TEXT,
  superseded_at TEXT,
  archived_at TEXT,
  author_type TEXT NOT NULL DEFAULT 'collaborative' CHECK (author_type IN ('human', 'agent', 'collaborative')),
  author_label TEXT NOT NULL DEFAULT '',
  source_ref TEXT,
  metadata TEXT NOT NULL DEFAULT '{}',
  embedding TEXT,
  embedding_model TEXT,
  embedding_dimensions INTEGER,
  embedding_version INTEGER NOT NULL DEFAULT 1,
  embedding_hash TEXT,
  embedding_status TEXT NOT NULL DEFAULT 'pending' CHECK (embedding_status IN ('pending', 'ready', 'failed', 'disabled')),
  embedding_error TEXT,
  embedded_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_decisions_user_status_updated ON decisions(user_id, status, updated_at);
CREATE INDEX idx_decisions_user_decided ON decisions(user_id, decided_at);
CREATE INDEX idx_decisions_user_review_due ON decisions(user_id, review_due_at);
CREATE INDEX idx_decisions_user_embedding_status ON decisions(user_id, embedding_status);

CREATE TABLE tags (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  color TEXT,
  archived_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(user_id, slug)
);

CREATE INDEX idx_tags_user_slug ON tags(user_id, slug);

CREATE TABLE decision_tags (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  decision_id TEXT NOT NULL REFERENCES decisions(id) ON DELETE CASCADE,
  tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(user_id, decision_id, tag_id)
);

CREATE INDEX idx_decision_tags_user_decision ON decision_tags(user_id, decision_id);
CREATE INDEX idx_decision_tags_user_tag ON decision_tags(user_id, tag_id);

CREATE TABLE decision_revisions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  decision_id TEXT NOT NULL REFERENCES decisions(id) ON DELETE CASCADE,
  revision_num INTEGER NOT NULL,
  snapshot TEXT NOT NULL,
  changed_fields TEXT NOT NULL DEFAULT '[]',
  change_comment TEXT,
  author_type TEXT NOT NULL DEFAULT 'collaborative',
  author_label TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(user_id, decision_id, revision_num)
);

CREATE INDEX idx_decision_revisions_user_decision ON decision_revisions(user_id, decision_id, revision_num);

CREATE TABLE decision_comments (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  decision_id TEXT NOT NULL REFERENCES decisions(id) ON DELETE CASCADE,
  kind TEXT NOT NULL DEFAULT 'note' CHECK (kind IN ('note', 'question', 'implementation', 'outcome', 'clarification')),
  body TEXT NOT NULL,
  author_type TEXT NOT NULL DEFAULT 'collaborative' CHECK (author_type IN ('human', 'agent', 'collaborative')),
  author_label TEXT NOT NULL DEFAULT '',
  source_ref TEXT,
  include_in_context INTEGER NOT NULL DEFAULT 0 CHECK (include_in_context IN (0, 1)),
  resolved_at TEXT,
  deleted_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_decision_comments_user_decision ON decision_comments(user_id, decision_id, created_at);

CREATE TABLE decision_relations (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  from_decision_id TEXT NOT NULL REFERENCES decisions(id) ON DELETE CASCADE,
  to_decision_id TEXT NOT NULL REFERENCES decisions(id) ON DELETE CASCADE,
  relation_type TEXT NOT NULL CHECK (relation_type IN ('supersedes', 'related_to', 'depends_on', 'implements', 'conflicts_with')),
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(user_id, from_decision_id, to_decision_id, relation_type)
);

CREATE INDEX idx_decision_relations_user_from ON decision_relations(user_id, from_decision_id);
CREATE INDEX idx_decision_relations_user_to ON decision_relations(user_id, to_decision_id);

CREATE TABLE decision_evidence (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  decision_id TEXT NOT NULL REFERENCES decisions(id) ON DELETE CASCADE,
  evidence_type TEXT NOT NULL DEFAULT 'reference' CHECK (evidence_type IN ('pr', 'commit', 'file', 'url', 'task', 'run', 'reference')),
  label TEXT NOT NULL DEFAULT '',
  ref TEXT NOT NULL,
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_decision_evidence_user_decision ON decision_evidence(user_id, decision_id);
