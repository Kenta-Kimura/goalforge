ALTER TABLE problems ADD COLUMN supplemental_info TEXT;

CREATE TABLE problem_attempts_v2 (
  id TEXT PRIMARY KEY,
  problem_id TEXT NOT NULL REFERENCES problems(id) ON DELETE CASCADE,
  round_id TEXT NOT NULL REFERENCES practice_rounds(id) ON DELETE CASCADE,
  answered_at TEXT NOT NULL,
  earned_score_milli INTEGER NOT NULL CHECK (earned_score_milli >= 0),
  max_score_milli INTEGER NOT NULL CHECK (max_score_milli >= 1000),
  confidence TEXT CHECK (confidence IN ('high', 'medium', 'low')),
  note TEXT,
  CHECK (earned_score_milli <= max_score_milli)
);

INSERT INTO problem_attempts_v2 (
  id, problem_id, round_id, answered_at, earned_score_milli,
  max_score_milli, confidence, note
)
SELECT
  id, problem_id, round_id, answered_at, earned_score_milli,
  max_score_milli,
  CASE confidence
    WHEN 'confident' THEN 'high'
    WHEN 'unsure' THEN 'low'
    ELSE confidence
  END,
  note
FROM problem_attempts;

DROP TABLE problem_attempts;
ALTER TABLE problem_attempts_v2 RENAME TO problem_attempts;

CREATE INDEX idx_attempts_problem_answered
  ON problem_attempts(problem_id, answered_at DESC);
