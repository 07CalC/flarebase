-- file metadata for the `file` field type (actual bytes live in R2 under
-- `FILE_BUCKET`, keyed by storageKey). Records are written and deleted by the
-- file service, not by the generic records API.
CREATE TABLE IF NOT EXISTS _files (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(5)))),
  collectionId TEXT NOT NULL,
  recordId TEXT NOT NULL,
  field TEXT NOT NULL,
  filename TEXT NOT NULL,
  size INTEGER NOT NULL,
  mime TEXT NOT NULL,
  checksum TEXT,
  storageKey TEXT NOT NULL UNIQUE,
  createdAt TIMESTAMP NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updatedAt TIMESTAMP NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_files_record ON _files(collectionId, recordId);

INSERT INTO _collections (id, name, system, type, fields, indexes, listRule, viewRule, createRule, updateRule, deleteRule, options) VALUES
  ('_files', '_files', 1, 'base', '[
  {"name": "collectionId", "type": "text", "required": true},
  {"name": "recordId", "type": "text", "required": true},
  {"name": "field", "type": "text", "required": true},
  {"name": "filename", "type": "text", "required": true},
  {"name": "size", "type": "number", "required": true},
  {"name": "mime", "type": "text", "required": true},
  {"name": "checksum", "type": "text"},
  {"name": "storageKey", "type": "text", "required": true, "unique": true}
  ]',
  '[{"name": "idx_files_record", "on": ["collectionId", "recordId"]}]',
  null, null, null, null, null, '{}');
