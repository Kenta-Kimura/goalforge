PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS app_state (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS data_migrations (
  migration_key TEXT PRIMARY KEY,
  version INTEGER NOT NULL,
  completed_at TEXT NOT NULL,
  details_json TEXT
);

CREATE TABLE IF NOT EXISTS materials (
  id TEXT PRIMARY KEY,
  goal_id TEXT,
  title TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS question_banks (
  id TEXT PRIMARY KEY,
  material_id TEXT NOT NULL REFERENCES materials(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS question_sections (
  id TEXT PRIMARY KEY,
  question_bank_id TEXT NOT NULL REFERENCES question_banks(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  sort_order INTEGER NOT NULL,
  evaluation_type TEXT NOT NULL CHECK (evaluation_type IN ('binary', 'partial_score', 'mixed')),
  is_mock_exam_section INTEGER NOT NULL DEFAULT 0 CHECK (is_mock_exam_section IN (0, 1))
);

CREATE TABLE IF NOT EXISTS problems (
  id TEXT PRIMARY KEY,
  section_id TEXT NOT NULL REFERENCES question_sections(id) ON DELETE CASCADE,
  number TEXT NOT NULL,
  title TEXT,
  sort_order INTEGER NOT NULL,
  default_max_score_milli INTEGER NOT NULL CHECK (default_max_score_milli > 0),
  evaluation_type_override TEXT CHECK (evaluation_type_override IN ('binary', 'partial_score')),
  review_status TEXT NOT NULL DEFAULT 'active'
    CHECK (review_status IN ('active', 'completed', 'paused', 'excluded'))
);

CREATE TABLE IF NOT EXISTS practice_rounds (
  id TEXT PRIMARY KEY,
  question_bank_id TEXT NOT NULL REFERENCES question_banks(id) ON DELETE CASCADE,
  round_number INTEGER NOT NULL CHECK (round_number > 0),
  title TEXT,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  UNIQUE(question_bank_id, round_number)
);

CREATE TABLE IF NOT EXISTS round_target_problems (
  round_id TEXT NOT NULL REFERENCES practice_rounds(id) ON DELETE CASCADE,
  problem_id TEXT NOT NULL REFERENCES problems(id) ON DELETE CASCADE,
  sort_order INTEGER NOT NULL,
  PRIMARY KEY (round_id, problem_id)
);

CREATE TABLE IF NOT EXISTS problem_attempts (
  id TEXT PRIMARY KEY,
  problem_id TEXT NOT NULL REFERENCES problems(id) ON DELETE CASCADE,
  round_id TEXT NOT NULL REFERENCES practice_rounds(id) ON DELETE CASCADE,
  answered_at TEXT NOT NULL,
  earned_score_milli INTEGER NOT NULL CHECK (earned_score_milli >= 0),
  max_score_milli INTEGER NOT NULL CHECK (max_score_milli > 0),
  confidence TEXT CHECK (confidence IN ('confident', 'unsure')),
  note TEXT,
  CHECK (earned_score_milli <= max_score_milli)
);

CREATE INDEX IF NOT EXISTS idx_sections_bank_order
  ON question_sections(question_bank_id, sort_order);
CREATE INDEX IF NOT EXISTS idx_problems_section_order
  ON problems(section_id, sort_order);
CREATE INDEX IF NOT EXISTS idx_rounds_bank_number
  ON practice_rounds(question_bank_id, round_number);
CREATE INDEX IF NOT EXISTS idx_attempts_problem_answered
  ON problem_attempts(problem_id, answered_at DESC);
