CREATE TABLE IF NOT EXISTS _migrations (
  id TEXT PRIMARY KEY,
  version INTEGER NOT NULL,
  applied TIMESTAMP NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS _collections (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(5)))), name TEXT NOT NULL, system BOOLEAN NOT NULL DEFAULT FALSE,
  type TEXT NOT NULL DEFAULT 'base' CHECK (type IN ('base', 'auth', 'view')),
  fields JSON NOT NULL DEFAULT '[]',
  indexes JSON NOT NULL DEFAULT '[]',
  -- NULL rules represents superuser only, empty represents everyone
  listRule TEXT DEFAULT NULL,
  viewRule TEXT DEFAULT NULL,
  createRule TEXT DEFAULT NULL,
  updateRule TEXT DEFAULT NULL,
  deleteRule TEXT DEFAULT NULL,
  -- compiled artifacts for the rule text above (API_RULES.md §5); internal, never serialized
  compiledRules JSON NOT NULL DEFAULT '{}',

  options JSON DEFAULT '{}' NOT NULL,
  createdAt TIMESTAMP NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updatedAt TIMESTAMP NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_collections_name ON _collections(name);

-- field metadata carries the per-field validation options (min/max etc.),
-- which the record routes turn into runtime request validation schemas
INSERT INTO _collections (id, name, system, type, fields, indexes, listRule, viewRule, createRule, updateRule, deleteRule, options) VALUES
  ('_superusers', '_superusers', 1, 'auth', '[{"name":"email","type":"email","required":true,"unique":true,"max":254},{"name":"password","type":"text","required":true,"min":8,"max":128}]', '[{"name": "idx_superusers_email", "on": "email"}]', null, null, null, null, null, '{}');

CREATE TABLE IF NOT EXISTS _superusers (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(5)))),
  email TEXT NOT NULL UNIQUE,
  password TEXT NOT NULL,
  createdAt TIMESTAMP NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updatedAt TIMESTAMP NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_superusers_email ON _superusers(email);
