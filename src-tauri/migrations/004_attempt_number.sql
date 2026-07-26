CREATE TABLE problem_attempts_v3 (
  id TEXT PRIMARY KEY,
  problem_id TEXT NOT NULL REFERENCES problems(id) ON DELETE CASCADE,
  round_id TEXT NOT NULL REFERENCES practice_rounds(id) ON DELETE CASCADE,
  answered_at TEXT,
  attempt_number INTEGER NOT NULL CHECK (attempt_number > 0),
  earned_score_milli INTEGER NOT NULL CHECK (earned_score_milli >= 0),
  max_score_milli INTEGER NOT NULL CHECK (max_score_milli >= 1000),
  confidence TEXT CHECK (confidence IN ('high', 'medium', 'low')),
  note TEXT,
  UNIQUE(problem_id, attempt_number),
  CHECK (earned_score_milli <= max_score_milli)
);

INSERT INTO problem_attempts_v3 (
  id,
  problem_id,
  round_id,
  answered_at,
  attempt_number,
  earned_score_milli,
  max_score_milli,
  confidence,
  note
)
SELECT
  id,
  problem_id,
  round_id,
  answered_at,
  ROW_NUMBER() OVER (
    PARTITION BY problem_id
    ORDER BY answered_at ASC, id ASC
  ),
  earned_score_milli,
  max_score_milli,
  confidence,
  note
FROM problem_attempts;

DROP TABLE problem_attempts;
ALTER TABLE problem_attempts_v3 RENAME TO problem_attempts;

CREATE INDEX idx_attempts_problem_number
  ON problem_attempts(problem_id, attempt_number DESC);
CREATE INDEX idx_attempts_problem_answered
  ON problem_attempts(problem_id, answered_at DESC);
