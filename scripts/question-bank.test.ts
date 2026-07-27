import assert from "node:assert/strict";
import test from "node:test";
import {
  calculateBankSummary,
  calculateMockExamSummary,
  calculatePracticeRoundAccuracies,
  calculateRoundSummary,
  deriveScoreResult,
  getPracticeRoundHistory,
  latestAttempt,
  matchesFilter,
} from "../src/questionBank/analytics";
import { formatAttemptDate } from "../src/questionBank/presentation";
import { validateScore } from "../src/questionBank/service";
import type { Problem, ProblemAttempt, QuestionBank, QuestionFilters } from "../src/questionBank/types";

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

test("最新Attemptは学習日時ではなくProblemごとの解答番号で決める", () => {
  const olderDateButLaterAttempt = attempt("a2", "p1", 1, 1, "high", 2, null);
  const newerDateButEarlierAttempt = attempt("a1", "p1", 0, 1, "low", 1, "2026-07-20T00:00:00.000Z");
  assert.equal(latestAttempt(problem("p1", "active", [newerDateButEarlierAttempt, olderDateButLaterAttempt])).id, "a2");
});

test("日時不明Attemptは学習日不明と表示する", () => {
  assert.equal(formatAttemptDate(null), "学習日不明");
});

test("状態・最新解答・確信度・最新日を独立して組み合わせる", () => {
  const target = problem("p1", "active", [
    attempt("a1", "p1", 0, 1, "high", 1, "2026-07-21T10:00:00"),
  ]);
  assert.equal(matchesFilter(target, filters({
    statuses: ["active", "paused"],
    results: ["incorrect", "partial"],
    confidences: ["high", "medium"],
    latestFrom: "2026-07-21",
    latestTo: "2026-07-21",
  })), true);
  assert.equal(matchesFilter(target, filters({ statuses: ["completed", "excluded"] })), false);
  assert.equal(matchesFilter(target, filters({ results: ["correct", "partial"] })), false);
  assert.equal(matchesFilter(target, filters({ confidences: ["low", "unset"] })), false);
  assert.equal(matchesFilter(target, filters({ latestFrom: "2026-07-22" })), false);
});

test("未解答と最新日の条件は別々に判定する", () => {
  const unanswered = problem("p1", "active", []);
  assert.equal(matchesFilter(unanswered, filters({ results: ["unanswered", "incorrect"] })), true);
  assert.equal(matchesFilter(unanswered, filters({ results: ["unanswered"], latestFrom: "2026-07-01" })), false);
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

test("1周のみの正解率を集計する", () => {
  const bank = withRounds(makeBank([
    problem("p1", "active", [attempt("a1", "p1", 1, 1, null, 1)]),
    problem("p2", "active", [attempt("a2", "p2", 0, 1, null, 1)]),
  ]), [1]);
  assert.deepEqual(calculatePracticeRoundAccuracies(bank), [{
    roundNumber: 1,
    correctCount: 1,
    problemCount: 2,
    accuracyRate: 0.5,
  }]);
});

test("2周・3周を既存のPracticeRoundごとに分けて集計する", () => {
  const bank = withRounds(makeBank([
    problem("p1", "active", [
      attempt("p1-a1", "p1", 1, 1, null, 1, undefined, "round-1"),
      attempt("p1-a2", "p1", 0, 1, null, 2, undefined, "round-2"),
      attempt("p1-a3", "p1", 1, 1, null, 3, undefined, "round-3"),
    ]),
    problem("p2", "active", [
      attempt("p2-a1", "p2", 0, 1, null, 1, undefined, "round-1"),
      attempt("p2-a2", "p2", 1, 1, null, 2, undefined, "round-2"),
      attempt("p2-a3", "p2", 1, 1, null, 3, undefined, "round-3"),
    ]),
  ]), [1, 2, 3]);
  assert.deepEqual(
    calculatePracticeRoundAccuracies(bank).map(({ roundNumber, correctCount, problemCount }) => (
      { roundNumber, correctCount, problemCount }
    )),
    [
      { roundNumber: 1, correctCount: 1, problemCount: 2 },
      { roundNumber: 2, correctCount: 1, problemCount: 2 },
      { roundNumber: 3, correctCount: 2, problemCount: 2 },
    ],
  );
});

test("途中終了した周は実際に解答した問題だけを分母にする", () => {
  const bank = withRounds(makeBank([
    problem("p1", "active", [
      attempt("p1-a1", "p1", 1, 1, null, 1, undefined, "round-1"),
      attempt("p1-a2", "p1", 1, 1, null, 2, undefined, "round-2"),
    ]),
    problem("p2", "active", [
      attempt("p2-a1", "p2", 1, 1, null, 1, undefined, "round-1"),
      attempt("p2-a2", "p2", 0, 1, null, 2, undefined, "round-2"),
    ]),
    problem("p3", "active", [attempt("p3-a1", "p3", 1, 1, null, 1)]),
  ]), [1, 2]);
  const second = calculatePracticeRoundAccuracies(bank)[1];
  assert.deepEqual(
    { correctCount: second.correctCount, problemCount: second.problemCount, accuracyRate: second.accuracyRate },
    { correctCount: 1, problemCount: 2, accuracyRate: 0.5 },
  );
});

test("未回答問題は周回の分母へ含めない", () => {
  const bank = withRounds(makeBank([
    problem("p1", "active", [attempt("a1", "p1", 1, 1, null, 1)]),
    problem("p2", "active", []),
  ]), [1]);
  assert.equal(calculatePracticeRoundAccuracies(bank)[0].problemCount, 1);
});

test("周回正解率は100%と0%を表現できる", () => {
  const bank = withRounds(makeBank([
    problem("p1", "active", [
      attempt("p1-a1", "p1", 1, 1, null, 1, undefined, "round-1"),
      attempt("p1-a2", "p1", 0, 1, null, 2, undefined, "round-2"),
    ]),
    problem("p2", "active", [
      attempt("p2-a1", "p2", 1, 1, null, 1, undefined, "round-1"),
      attempt("p2-a2", "p2", 0, 1, null, 2, undefined, "round-2"),
    ]),
  ]), [1, 2]);
  const rounds = calculatePracticeRoundAccuracies(bank);
  assert.equal(rounds[0].accuracyRate, 1);
  assert.equal(rounds[1].accuracyRate, 0);
});

test("Numbersの周回番号を使い、空欄を詰めた解答番号から周回を推測しない", () => {
  const bank = withRounds(makeBank([
    problem("p1", "active", [
      attempt("a1", "p1", 1, 1, null, 1, undefined, "round-2"),
    ]),
  ]), [2]);
  assert.deepEqual(calculatePracticeRoundAccuracies(bank), [{
    roundNumber: 2,
    correctCount: 1,
    problemCount: 1,
    accuracyRate: 1,
  }]);
});

test("解答履歴はNumbersの周回順に並べ、履歴がない周回を空欄として維持する", () => {
  const bank = withRounds(makeBank([
    problem("p1", "active", [
      attempt("a1", "p1", 1, 1, null, 1, undefined, "round-2"),
      attempt("a2", "p1", 0, 1, null, 2, undefined, "round-4"),
    ]),
  ]), [1, 2, 3, 4]);
  assert.deepEqual(
    getPracticeRoundHistory(bank, bank.sections[0].problems[0])
      .map((entry) => ({
        roundNumber: entry.roundNumber,
        attemptId: entry.attempt?.id ?? null,
      })),
    [
      { roundNumber: 1, attemptId: null },
      { roundNumber: 2, attemptId: "a1" },
      { roundNumber: 3, attemptId: null },
      { roundNumber: 4, attemptId: "a2" },
    ],
  );
});

function filters(overrides: Partial<QuestionFilters> = {}): QuestionFilters {
  return {
    statuses: [],
    results: [],
    confidences: [],
    latestFrom: "",
    latestTo: "",
    ...overrides,
  };
}

function attempt(
  id: string,
  problemId: string,
  earnedScore: number,
  maxScore: number,
  confidence: ProblemAttempt["confidence"],
  attemptNumber = Number(id.slice(-1)),
  answeredAt: string | null = `2026-07-${id.slice(-1).padStart(2, "0")}T00:00:00.000Z`,
  roundId = "round-1",
): ProblemAttempt {
  return { id, problemId, roundId, answeredAt, attemptNumber, earnedScore, maxScore, confidence };
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

function withRounds(bank: QuestionBank, roundNumbers: number[]): QuestionBank {
  return {
    ...bank,
    rounds: roundNumbers.map((roundNumber) => ({
      id: `round-${roundNumber}`,
      questionBankId: bank.id,
      roundNumber,
      startedAt: "2026-07-01T00:00:00.000Z",
      targetProblemIds: bank.sections.flatMap((section) => section.problems.map((problem) => problem.id)),
    })),
  };
}
