import assert from "node:assert/strict";
import test from "node:test";
import {
  calculateBankSummary,
  calculateMockExamSummary,
  calculateRoundSummary,
  deriveScoreResult,
  selectRoundTargetProblemIds,
} from "../src/questionBank/analytics";
import { validateScore } from "../src/questionBank/service";
import type { Problem, ProblemAttempt, QuestionBank } from "../src/questionBank/types";

test("得点から○△×を導出する", () => {
  assert.equal(deriveScoreResult(1, 1), "correct");
  assert.equal(deriveScoreResult(0, 1), "incorrect");
  assert.equal(deriveScoreResult(3, 5), "partial");
  assert.equal(deriveScoreResult(5, 5), "correct");
  assert.equal(deriveScoreResult(0, 5), "incorrect");
});

test("得点の範囲を検証する", () => {
  assert.doesNotThrow(() => validateScore(3, 5));
  assert.throws(() => validateScore(-1, 5));
  assert.throws(() => validateScore(6, 5));
  assert.throws(() => validateScore(0, 0));
});

test("点数と自信を独立して集計する", () => {
  const bank = makeBank([
    problem("p1", "completed", [attempt("a1", "p1", 1, 1, "high")]),
    problem("p2", "active", [attempt("a2", "p2", 1, 1, "low")]),
    problem("p3", "active", [attempt("a3", "p3", 0, 1, "high")]),
    problem("p4", "active", [attempt("a4", "p4", 3, 5, "low")]),
    problem("p5", "paused", [attempt("a5", "p5", 1, 1, null)]),
  ]);
  const summary = calculateRoundSummary(bank, bank.rounds[0]);
  assert.deepEqual(
    {
      correct: summary.correct,
      partial: summary.partial,
      incorrect: summary.incorrect,
      confidentCorrect: summary.confidentCorrect,
      unsureCorrect: summary.unsureCorrect,
      confidentIncorrect: summary.confidentIncorrect,
    },
    { correct: 3, partial: 1, incorrect: 1, confidentCorrect: 1, unsureCorrect: 1, confidentIncorrect: 1 },
  );
});

test("周回の分母は対象問題で、未解答を0点にしない", () => {
  const bank = makeBank([
    problem("p1", "active", [attempt("a1", "p1", 1, 1, "high")]),
    problem("p2", "active", [attempt("a2", "p2", 3, 5, "low")]),
    problem("p3", "active", []),
  ]);
  const summary = calculateRoundSummary(bank, bank.rounds[0]);
  assert.equal(summary.target, 3);
  assert.equal(summary.answered, 2);
  assert.equal(summary.earnedScore, 4);
  assert.equal(summary.maxScore, 6);
  assert.equal(summary.scoreRate, (4 / 6) * 100);
});

test("除外問題を復習完了として数えない", () => {
  const bank = makeBank([
    problem("p1", "completed", []),
    problem("p2", "excluded", []),
    problem("p3", "active", []),
  ]);
  const summary = calculateBankSummary(bank);
  assert.equal(summary.completed, 1);
  assert.equal(summary.excluded, 1);
});

test("履歴の満点は既定配点変更の影響を受けない", () => {
  const oldAttempt = attempt("a1", "p1", 3, 5, "low");
  const bank = makeBank([problem("p1", "active", [oldAttempt], 10)]);
  const summary = calculateRoundSummary(bank, bank.rounds[0]);
  assert.equal(summary.maxScore, 5);
});

test("模擬試験大問の得点を履歴から集計する", () => {
  const bank = makeBank([
    problem("p1", "active", [attempt("a1", "p1", 8, 10, "high")]),
    problem("p2", "active", [attempt("a2", "p2", 5, 5, "high")]),
  ], true);
  const [summary] = calculateMockExamSummary(bank, bank.rounds[0]);
  assert.equal(summary.earnedScore, 13);
  assert.equal(summary.maxScore, 15);
});

test("1周目・次周回・全問題の対象を選び、開始後のスナップショットを変えない", () => {
  const bank = makeBank([
    problem("p1", "active", []),
    problem("p2", "completed", []),
    problem("p3", "paused", []),
    problem("p4", "excluded", []),
  ]);
  assert.deepEqual(selectRoundTargetProblemIds(bank, "active"), ["p1"]);
  assert.deepEqual(selectRoundTargetProblemIds(bank, "all"), ["p1", "p2", "p3"]);
  const snapshot = selectRoundTargetProblemIds(bank, "active");
  bank.sections[0].problems[0].reviewStatus = "completed";
  assert.deepEqual(snapshot, ["p1"]);
  bank.sections[0].problems[1].reviewStatus = "active";
  assert.deepEqual(selectRoundTargetProblemIds(bank, "active"), ["p2"]);
});

function attempt(
  id: string,
  problemId: string,
  earnedScore: number,
  maxScore: number,
  confidence: ProblemAttempt["confidence"],
): ProblemAttempt {
  return { id, problemId, roundId: "round-1", answeredAt: `2026-07-${id.slice(-1).padStart(2, "0")}T00:00:00.000Z`, earnedScore, maxScore, confidence };
}

function problem(
  id: string,
  reviewStatus: Problem["reviewStatus"],
  attempts: ProblemAttempt[],
  defaultMaxScore = attempts[0]?.maxScore ?? 1,
): Problem {
  return { id, sectionId: "section-1", number: id.slice(1), order: Number(id.slice(1)), defaultMaxScore, reviewStatus, attempts };
}

function makeBank(problems: Problem[], isMockExamSection = false): QuestionBank {
  return {
    id: "bank-1",
    materialId: "material-1",
    title: "テスト問題集",
    sections: [{
      id: "section-1",
      questionBankId: "bank-1",
      title: "第1問",
      order: 0,
      evaluationType: "mixed",
      isMockExamSection,
      problems,
    }],
    rounds: [{
      id: "round-1",
      questionBankId: "bank-1",
      roundNumber: 1,
      startedAt: "2026-07-01T00:00:00.000Z",
      targetProblemIds: problems.map((item) => item.id),
    }],
  };
}
