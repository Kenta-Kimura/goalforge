-- question_banks は旧UI/APIとの互換レイヤーとして残す。
-- 教材と演習構造が1対1であることを保証し、問題マスターの重複を防ぐ。
CREATE UNIQUE INDEX IF NOT EXISTS idx_question_banks_material_unique
  ON question_banks(material_id);
