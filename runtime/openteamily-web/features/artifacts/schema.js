// Artifact tables for this user's DS-Bot (legacy artifacts.py SCHEMA, without
// cross-feature FK to workspaces/users: this volume is already private to one owner).
export const MIGRATIONS = [`
CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  title TEXT NOT NULL,
  title_hash TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('document')),
  body TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK(revision >= 1),
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL,
  created_by TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  key_hash TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  UNIQUE(workspace_id, key_hash),
  UNIQUE(workspace_id, title_hash));
CREATE INDEX IF NOT EXISTS artifact_workspace ON artifacts(workspace_id, id);
CREATE TABLE IF NOT EXISTS artifact_versions (
  artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL CHECK(revision >= 1),
  title TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('document', 'website', 'whiteboard', 'media')),
  body TEXT NOT NULL,
  board TEXT,
  mime TEXT,
  byte_count INTEGER,
  sha256 TEXT,
  filename TEXT,
  created INTEGER NOT NULL,
  created_by TEXT NOT NULL,
  PRIMARY KEY (artifact_id, revision));
CREATE INDEX IF NOT EXISTS artifact_version_item ON artifact_versions(artifact_id, revision);
`]
