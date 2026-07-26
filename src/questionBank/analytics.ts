import type {
  Problem,
  ProblemAttempt,
  PracticeRound,
  QuestionBank,
  QuestionFilters,
  QuestionSection,
  ScoreResult,
} from "./types";

export function deriveScoreResult(earnedScore: number, maxScore: number): ScoreResult {
  if (earnedScore >= maxScore) return "correct";
  if (earnedScore <= 0) return "incorrect";
  return "partial";
}

export function latestAttempt(problem: Problem) {
  return [...problem.attempts].sort((a, b) => b.attemptNumber - a.attemptNumber)[0];
}

export function matchesFilter(problem: Problem, filters: QuestionFilters) {
  if (filters.statuses.length > 0 && !filters.statuses.includes(problem.reviewStatus)) return false;
  const attempt = latestAttempt(problem);
  if (filters.results.length > 0) {
    const result = attempt ? deriveScoreResult(attempt.earnedScore, attempt.maxScore) : "unanswered";
    if (!filters.results.includes(result)) return false;
  }
  if (filters.confidences.length > 0) {
    if (!attempt) return false;
    const confidence = attempt.confidence ?? "unset";
    if (!filters.confidences.includes(confidence)) return false;
  }
  if (filters.latestFrom || filters.latestTo) {
    const latestDay = attemptDay(attempt?.answeredAt);
    if (!latestDay) return false;
    if (filters.latestFrom && latestDay < filters.latestFrom) return false;
    if (filters.latestTo && latestDay > filters.latestTo) return false;
  }
  return true;
}

function attemptDay(value: string | null | undefined) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function calculateBankSummary(bank: QuestionBank) {
  const problems = bank.sections.flatMap((section) => section.problems);
  const answered = problems.filter((problem) => problem.attempts.length > 0).length;
  const count = (status: Problem["reviewStatus"]) =>
    problems.filter((problem) => problem.reviewStatus === status).length;
  return {
    total: problems.length,
    answered,
    unanswered: problems.length - answered,
    active: count("active"),
    completed: count("completed"),
    paused: count("paused"),
    excluded: count("excluded"),
  };
}

export function calculateRoundSummary(bank: QuestionBank, round: PracticeRound) {
  const target = new Set(round.targetProblemIds);
  const attempts = bank.sections
    .flatMap((section) => section.problems)
    .filter((problem) => target.has(problem.id))
    .flatMap((problem) => problem.attempts.filter((attempt) => attempt.roundId === round.id));
  const latestByProblem = new Map<string, ProblemAttempt>();
  for (const attempt of attempts) {
    const current = latestByProblem.get(attempt.problemId);
    if (!current || current.attemptNumber < attempt.attemptNumber) latestByProblem.set(attempt.problemId, attempt);
  }
  const latest = [...latestByProblem.values()];
  const earnedScore = latest.reduce((sum, attempt) => sum + attempt.earnedScore, 0);
  const maxScore = latest.reduce((sum, attempt) => sum + attempt.maxScore, 0);
  const resultCount = (result: ScoreResult) =>
    latest.filter((attempt) => deriveScoreResult(attempt.earnedScore, attempt.maxScore) === result)
      .length;
  return {
    target: round.targetProblemIds.length,
    answered: latest.length,
    correct: resultCount("correct"),
    partial: resultCount("partial"),
    incorrect: resultCount("incorrect"),
    earnedScore,
    maxScore,
    scoreRate: maxScore ? (earnedScore / maxScore) * 100 : null,
    confidentCorrect: latest.filter(
      (a) => deriveScoreResult(a.earnedScore, a.maxScore) === "correct" && a.confidence === "high",
    ).length,
    unsureCorrect: latest.filter(
      (a) => deriveScoreResult(a.earnedScore, a.maxScore) === "correct" && a.confidence === "low",
    ).length,
    confidentIncorrect: latest.filter(
      (a) => deriveScoreResult(a.earnedScore, a.maxScore) === "incorrect" && a.confidence === "high",
    ).length,
  };
}

export function calculateMockExamSummary(bank: QuestionBank, round: PracticeRound) {
  return bank.sections
    .filter((section) => section.isMockExamSection)
    .map((section) => calculateSectionScore(section, round))
    .filter((summary) => summary.answered > 0);
}

function calculateSectionScore(section: QuestionSection, round: PracticeRound) {
  const target = new Set(round.targetProblemIds);
  const attempts = section.problems
    .filter((problem) => target.has(problem.id))
    .map((problem) =>
      [...problem.attempts]
        .filter((attempt) => attempt.roundId === round.id)
        .sort((a, b) => b.attemptNumber - a.attemptNumber)[0],
    )
    .filter((attempt): attempt is ProblemAttempt => Boolean(attempt));
  const earnedScore = attempts.reduce((sum, attempt) => sum + attempt.earnedScore, 0);
  const maxScore = attempts.reduce((sum, attempt) => sum + attempt.maxScore, 0);
  return {
    sectionId: section.id,
    title: section.title,
    answered: attempts.length,
    earnedScore,
    maxScore,
    scoreRate: maxScore ? (earnedScore / maxScore) * 100 : null,
  };
}
