import assert from "node:assert/strict";
import test from "node:test";
import { buildLearningHistoryExport } from "../src/questionBank/learningHistoryExport";
import type { Goal, StudyPlan } from "../src/types";
import type { QuestionBank } from "../src/questionBank/types";

const goal: Goal = {
  id: "goal-1", title: "中国語検定2級", subtitle: "", status: "active",
  readiness: 0, targetXp: 1, xp: 0, examDate: "2026-11-22", skillIds: [], collectionIds: [],
};

const plan: StudyPlan = {
  id: "plan-1", goalId: goal.id, planName: "計画", examDate: goal.examDate!, overallStrategy: "",
  milestones: [], warnings: [], importedAt: "2026-08-01T00:00:00Z", resourceMergeModes: {},
  resources: [{
    id: "resource-1", name: "教材A", type: "book", unit: "pages", targetAmount: 80,
    currentAmount: 20, weight: 100, weeklyTarget: 5, priority: "high", notes: "",
  }],
};

const bank: QuestionBank = {
  id: "bank-1", materialId: "material-1", title: "教材A",
  rounds: [
    { id: "round-2", questionBankId: "bank-1", roundNumber: 2, startedAt: "2026-08-02", targetProblemIds: ["p1"] },
    { id: "round-1", questionBankId: "bank-1", roundNumber: 1, startedAt: "2026-08-01", targetProblemIds: ["p1", "p2"] },
  ],
  sections: [{
    id: "section-1", questionBankId: "bank-1", title: "第1章", order: 0,
    evaluationType: "mixed", isMockExamSection: false,
    problems: [
      {
        id: "p1", sectionId: "section-1", number: "1", order: 0, defaultMaxScore: 2,
        reviewStatus: "completed", attempts: [
          { id: "a2", problemId: "p1", roundId: "round-2", answeredAt: "2026-08-02T00:00:00Z", attemptNumber: 2, earnedScore: 2, maxScore: 2, confidence: "high", note: "理解した" },
          { id: "a1", problemId: "p1", roundId: "round-1", answeredAt: "2026-08-01T00:00:00Z", attemptNumber: 1, earnedScore: 1, maxScore: 2, confidence: "low" },
        ],
      },
      { id: "p2", sectionId: "section-1", number: "2", order: 1, defaultMaxScore: 1, reviewStatus: "active", attempts: [] },
    ],
  }],
};

test("builds a fixed, rounded export from actual learning history", () => {
  const result = buildLearningHistoryExport(bank, goal, plan, "2026-08-08T01:00:00.000Z");
  assert.equal(result.exportVersion, "1.0");
  assert.deepEqual(result.resource.progress, { current: 20, target: 80, unit: "pages", percent: 25 });
  assert.equal(result.summary.totalAttempts, 2);
  assert.equal(result.summary.uniqueProblemsAttempted, 1);
  assert.equal(result.summary.correctAttempts, 1);
  assert.equal(result.summary.accuracy, 50);
  assert.equal(result.summary.averageScoreRate, 75);
  assert.deepEqual(result.summary.statusTransitions, []);
  assert.deepEqual(result.summary.confidenceMatrix.high, { correct: 1, incorrect: 0 });
  assert.deepEqual(result.summary.confidenceMatrix.low, { correct: 0, incorrect: 1 });
  assert.deepEqual(result.summary.byRound.map((item) => item.round), [1, 2]);
  assert.equal(result.problems[0].latestResult?.round, 2);
  assert.equal(result.problems[0].latestResult?.memo, "理解した");
  assert.equal("memo" in result.problems[0].history[0], false);
  assert.equal(result.problems[1].latestResult, null);
});

test("uses null for unavailable plan values and zero denominators", () => {
  const result = buildLearningHistoryExport({ ...bank, title: "未連携教材", sections: [] }, goal, undefined);
  assert.deepEqual(result.resource.progress, { current: null, target: null, unit: null, percent: null });
  assert.equal(result.resource.type, null);
  assert.equal(result.summary.accuracy, null);
  assert.equal(result.summary.averageScoreRate, null);
});
