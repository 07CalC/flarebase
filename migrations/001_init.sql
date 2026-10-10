CREATE TABLE IF NOT EXISTS _migrations (
  id TEXT PRIMARY KEY,
  version SERIAL NOT NULL,
  applied TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS _collections (
  id TEXT PRIMARY KEY DEFAULT lower(hex(randomblob(5))),
  name TEXT NOT NULL,
  system BOOLEAN NOT NULL DEFAULT FALSE,
  type TEXT NOT NULL DEFAULT 'base' CHECK (type IN ('base', 'auth', 'view'),
  fields JSON NOT NULL DEFAULT '[]',
  indexes JSON NOT NULL DEFAULT '[]',
  -- NULL rules represents superuser only, empty represents everyone
  listRule TEXT DEFAULT NULL,
  viewRule TEXT DEFAULT NULL,
  createRule TEXT DEFAULT NULL,
  updateRule TEXT DEFAULT NULL,
  deleteRule TEXT DEFAULT NULL,

  options JSON DEFAULT '{}' NOT NULL,
  createdAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updatedAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO _collections (id, name, system, type, fields, indexes, listRule, viewRule, createRule, updateRule, deleteRule, options) VALUES
  ('_superusers', '_superusers', 1, 'auth', '[{"name":"email","type":"text","required":true,"unique":true},{"name":"password","type":"text","required":true}]', '[]', null, null, null, null, null, '{}');

CREATE TABLE IF NOT EXISTS _superusers (
  id TEXT PRIMARY KEY DEFAULT lower(hex(randomblob(5))),
  email TEXT NOT NULL UNIQUE,
  password TEXT NOT NULL,
  createdAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updatedAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
