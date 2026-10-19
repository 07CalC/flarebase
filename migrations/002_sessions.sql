CREATE TABLE IF NOT EXISTS _sessions (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  collectionId TEXT NOT NULL,
  userId TEXT NOT NULL,
  jti TEXT NOT NULL UNIQUE,
  expiresAt INTEGER NOT NULL,
  revoked INTEGER NOT NULL DEFAULT 0,
  ip TEXT,
  userAgent TEXT,
  createdAt TIMESTAMP NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updatedAt TIMESTAMP NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_sessions_jti ON _sessions(jti);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON _sessions(collectionId, userId);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON _sessions(expiresAt);

INSERT INTO _collections(id, name, system, type, fields, indexes, listRule, viewRule, createRule, updateRule, deleteRule, options) VALUES
  ('_sessions', '_sessions', 1, 'base', '[
  {"name": "collectionId", "type": "text", "required": true}, 
  {"name": "userId", "type": "text", "required": true},
  {"name": "jti", "type": "text", "required": true, "unique": true}, 
  {"name": "expiresAt", "type": "number", "required": true}, 
  {"name": "revoked", "type": "bool", "required": true, "default": false}, 
  {"name": "ip", "type": "text"}, 
  {"name": "userAgent", "type": "text"}
  ]', 
  '[
  {"name": "idx_sessions_jti", "on": "jti"},
  {"name": "idx_sessions_user", "on": ["collectionId", "userId"]},
  {"name": "idx_sessions_expires", "on": "expiresAt"}
  ]'
  , null, null, null, null, null,'{}');
