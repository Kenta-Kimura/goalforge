import type {
  Problem,
  ProblemAttempt,
  PracticeRound,
  QuestionBank,
  QuestionFilter,
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

export function matchesFilter(problem: Problem, filter: QuestionFilter) {
  if (filter === "all") return true;
  if (["active", "completed", "paused", "excluded"].includes(filter)) {
    return problem.reviewStatus === filter;
  }
  const attempt = latestAttempt(problem);
  if (filter === "unanswered") return !attempt;
  if (!attempt) return false;
  const result = deriveScoreResult(attempt.earnedScore, attempt.maxScore);
  if (filter === "incorrect") return result === "incorrect";
  if (filter === "partial") return result === "partial";
  if (filter === "unsure") return attempt.confidence === "low";
  return result === "incorrect" && attempt.confidence === "high";
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
