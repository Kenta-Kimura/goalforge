CREATE TABLE custom_metrics (
  id TEXT PRIMARY KEY,
  question_bank_id TEXT NOT NULL
    REFERENCES question_banks(id) ON DELETE CASCADE,
  name TEXT NOT NULL
    CHECK (length(trim(name)) > 0),
  icon TEXT,
  definition_json TEXT NOT NULL
    CHECK (json_valid(definition_json)),
  definition_version INTEGER NOT NULL
    CHECK (definition_version > 0),
  population_json TEXT NOT NULL
    CHECK (json_valid(population_json)),
  is_visible INTEGER NOT NULL DEFAULT 1
    CHECK (is_visible IN (0, 1)),
  sort_order INTEGER NOT NULL
    CHECK (sort_order >= 0),
  origin TEXT NOT NULL
    CHECK (origin IN ('default', 'custom')),
  system_key TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  CHECK (
    json_type(definition_json, '$.version') = 'integer'
    AND json_extract(definition_json, '$.version') = definition_version
  ),
  CHECK (
    (origin = 'default' AND system_key IS NOT NULL)
    OR
    (origin = 'custom' AND system_key IS NULL)
  )
);

CREATE UNIQUE INDEX idx_custom_metrics_active_system_key
  ON custom_metrics(question_bank_id, system_key)
  WHERE deleted_at IS NULL AND system_key IS NOT NULL;

CREATE INDEX idx_custom_metrics_bank_active_order
  ON custom_metrics(question_bank_id, sort_order, id)
  WHERE deleted_at IS NULL;

CREATE INDEX idx_custom_metrics_bank_visible_order
  ON custom_metrics(question_bank_id, sort_order, id)
  WHERE deleted_at IS NULL AND is_visible = 1;
