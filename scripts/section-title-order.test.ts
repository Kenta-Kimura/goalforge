import assert from "node:assert/strict";
import test from "node:test";
import { sortQuestionBankSections } from "../src/questionBank/service";
import type { QuestionBank, QuestionSection } from "../src/questionBank/types";

test("セクションを作成順ではなく名前の自然順へ並べる", () => {
  const bank: QuestionBank = {
    id: "bank",
    materialId: "material",
    title: "教材",
    rounds: [],
    sections: [
      section("step-10", "STEP 10", 0),
      section("step-2-b", "STEP 2", 2),
      section("step-1", "STEP 1", 3),
      section("step-2-a", "STEP 2", 1),
    ],
  };

  const sorted = sortQuestionBankSections(bank);

  assert.deepEqual(sorted.sections.map((section) => section.id), [
    "step-1",
    "step-2-a",
    "step-2-b",
    "step-10",
  ]);
  assert.deepEqual(bank.sections.map((section) => section.id), [
    "step-10",
    "step-2-b",
    "step-1",
    "step-2-a",
  ]);
});

function section(id: string, title: string, order: number): QuestionSection {
  return {
    id,
    questionBankId: "bank",
    title,
    order,
    evaluationType: "binary",
    isMockExamSection: false,
    problems: [],
  };
}
