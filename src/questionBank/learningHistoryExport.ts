import type { Goal, StudyPlan, StudyResource } from "../types";
import { deriveScoreResult } from "./analytics";
import type { Confidence, ProblemAttempt, QuestionBank } from "./types";

const EXPORT_VERSION = "1.0";

type ConfidenceKey = Exclude<Confidence, null> | "unset";

interface CountSummary {
  attempts: number;
  correctAttempts: number;
  accuracy: number | null;
}

export function buildLearningHistoryExport(
  bank: QuestionBank,
  goal: Goal,
  plan: StudyPlan | undefined,
  exportedAt = new Date().toISOString(),
) {
  const resource = findStudyResource(bank, plan);
  const sections = bank.sections.flatMap((section) =>
    section.problems.map((problem) => ({ section, problem })),
  );
  const attempts = sections.flatMap(({ problem }) => problem.attempts);
  const rounds = new Map(bank.rounds.map((round) => [round.id, round.roundNumber]));

  return {
    exportVersion: EXPORT_VERSION,
    exportedAt,
    goal: {
      goalId: goal.id,
      name: goal.title,
      examDate: goal.examDate ?? null,
    },
    resource: {
      id: bank.materialId,
      name: bank.title,
      type: resource?.type ?? null,
      progress: {
        current: resource?.currentAmount ?? null,
        target: resource?.targetAmount ?? null,
        unit: resource?.unit ?? null,
        percent: resource ? percentage(resource.currentAmount, resource.targetAmount) : null,
      },
    },
    summary: {
      totalAttempts: attempts.length,
      uniqueProblemsAttempted: sections.filter(({ problem }) => problem.attempts.length > 0).length,
      correctAttempts: countCorrect(attempts),
      accuracy: accuracy(attempts),
      averageScoreRate: averageScoreRate(attempts),
      confidence: confidenceSummary(attempts),
      reviewStatus: {
        active: sections.filter(({ problem }) => problem.reviewStatus === "active").length,
        completed: sections.filter(({ problem }) => problem.reviewStatus === "completed").length,
        paused: sections.filter(({ problem }) => problem.reviewStatus === "paused").length,
        excluded: sections.filter(({ problem }) => problem.reviewStatus === "excluded").length,
      },
      byRound: [...bank.rounds]
        .sort((left, right) => left.roundNumber - right.roundNumber)
        .map((round) => {
          const roundAttempts = attempts.filter((attempt) => attempt.roundId === round.id);
          return {
            round: round.roundNumber,
            attempts: roundAttempts.length,
            correctAttempts: countCorrect(roundAttempts),
            accuracy: accuracy(roundAttempts),
            averageScoreRate: averageScoreRate(roundAttempts),
          };
        }),
      // The current schema stores only the latest review status, not its change history.
      statusTransitions: [],
      confidenceMatrix: confidenceMatrix(attempts),
    },
    problems: sections.map(({ section, problem }) => {
      const history = [...problem.attempts].sort(compareAttempts);
      const latest = [...history].sort((left, right) => right.attemptNumber - left.attemptNumber)[0];
      return {
        problemId: problem.id,
        section: section.title,
        number: problem.number,
        reviewStatus: problem.reviewStatus,
        attemptCount: history.length,
        latestResult: latest ? exportAttempt(latest, rounds, true) : null,
        history: history.map((attempt) => exportAttempt(attempt, rounds, false)),
      };
    }),
  };
}

export function downloadLearningHistoryJson(
  bank: QuestionBank,
  goal: Goal,
  plan: StudyPlan | undefined,
) {
  const json = JSON.stringify(buildLearningHistoryExport(bank, goal, plan), null, 2);
  downloadFile(json, "application/json;charset=utf-8", learningHistoryFileName(bank.title, "json"));
}

export function buildLearningHistoryCsv(
  bank: QuestionBank,
  goal: Goal,
  plan: StudyPlan | undefined,
  exportedAt = new Date().toISOString(),
) {
  const resource = findStudyResource(bank, plan);
  const rounds = new Map(bank.rounds.map((round) => [round.id, round.roundNumber]));
  const headers = [
    "exportVersion", "exportedAt", "goalId", "goalName", "examDate",
    "resourceId", "resourceName", "resourceType", "resourceCurrent", "resourceTarget", "resourceUnit", "resourcePercent",
    "problemId", "section", "number", "reviewStatus", "attemptNumber", "answeredAt", "round",
    "score", "maxScore", "scoreRate", "result", "correct", "confidence", "memo",
  ];
  const common = [
    EXPORT_VERSION, exportedAt, goal.id, goal.title, goal.examDate,
    bank.materialId, bank.title, resource?.type, resource?.currentAmount, resource?.targetAmount,
    resource?.unit, resource ? percentage(resource.currentAmount, resource.targetAmount) : null,
  ];
  const rows = bank.sections.flatMap((section) => section.problems.flatMap((problem) => {
    const problemFields = [problem.id, section.title, problem.number, problem.reviewStatus];
    if (problem.attempts.length === 0) return [[...common, ...problemFields, ...Array(10).fill(null)]];
    return [...problem.attempts].sort(compareAttempts).map((attempt) => {
      const result = deriveScoreResult(attempt.earnedScore, attempt.maxScore);
      return [
        ...common,
        ...problemFields,
        attempt.attemptNumber,
        attempt.answeredAt,
        rounds.get(attempt.roundId),
        attempt.earnedScore,
        attempt.maxScore,
        attempt.maxScore > 0 ? round1((attempt.earnedScore / attempt.maxScore) * 100) : null,
        result,
        result === "correct",
        attempt.confidence,
        attempt.note,
      ];
    });
  }));
  return [headers, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n");
}

export function downloadLearningHistoryCsv(
  bank: QuestionBank,
  goal: Goal,
  plan: StudyPlan | undefined,
) {
  const csv = `\uFEFF${buildLearningHistoryCsv(bank, goal, plan)}`;
  downloadFile(csv, "text/csv;charset=utf-8", learningHistoryFileName(bank.title, "csv"));
}

function downloadFile(content: string, type: string, fileName: string) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function learningHistoryFileName(title: string, extension: "json" | "csv" = "json") {
  const safeTitle = title.trim().replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_") || "material";
  return `${safeTitle}-learning-history.${extension}`;
}

function csvCell(value: unknown) {
  const text = value === null || value === undefined ? "" : String(value);
  return `"${text.replaceAll('"', '""')}"`;
}

function findStudyResource(bank: QuestionBank, plan: StudyPlan | undefined): StudyResource | undefined {
  return plan?.resources.find((resource) => resource.name === bank.title);
}

function exportAttempt(attempt: ProblemAttempt, rounds: Map<string, number>, includeMemo: boolean) {
  const exported: {
    answeredAt: string | null;
    round: number | null;
    score: number;
    maxScore: number;
    correct: boolean;
    confidence: Confidence;
    memo?: string | null;
  } = {
    answeredAt: attempt.answeredAt,
    round: rounds.get(attempt.roundId) ?? null,
    score: attempt.earnedScore,
    maxScore: attempt.maxScore,
    correct: deriveScoreResult(attempt.earnedScore, attempt.maxScore) === "correct",
    confidence: attempt.confidence,
  };
  if (includeMemo || attempt.note) exported.memo = attempt.note ?? null;
  return exported;
}

function compareAttempts(left: ProblemAttempt, right: ProblemAttempt) {
  const leftTime = left.answeredAt ? Date.parse(left.answeredAt) : Number.NaN;
  const rightTime = right.answeredAt ? Date.parse(right.answeredAt) : Number.NaN;
  if (Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime !== rightTime) return leftTime - rightTime;
  return left.attemptNumber - right.attemptNumber;
}

function confidenceSummary(attempts: ProblemAttempt[]) {
  return Object.fromEntries(confidenceKeys().map((key) => {
    const matching = attempts.filter((attempt) => (attempt.confidence ?? "unset") === key);
    return [key, countSummary(matching)];
  })) as Record<ConfidenceKey, CountSummary>;
}

function confidenceMatrix(attempts: ProblemAttempt[]) {
  return Object.fromEntries(confidenceKeys().map((key) => {
    const matching = attempts.filter((attempt) => (attempt.confidence ?? "unset") === key);
    const correct = countCorrect(matching);
    return [key, { correct, incorrect: matching.length - correct }];
  })) as Record<ConfidenceKey, { correct: number; incorrect: number }>;
}

function confidenceKeys(): ConfidenceKey[] {
  return ["high", "medium", "low", "unset"];
}

function countSummary(attempts: ProblemAttempt[]): CountSummary {
  return { attempts: attempts.length, correctAttempts: countCorrect(attempts), accuracy: accuracy(attempts) };
}

function countCorrect(attempts: ProblemAttempt[]) {
  return attempts.filter((attempt) => deriveScoreResult(attempt.earnedScore, attempt.maxScore) === "correct").length;
}

function accuracy(attempts: ProblemAttempt[]) {
  return attempts.length === 0 ? null : round1((countCorrect(attempts) / attempts.length) * 100);
}

function averageScoreRate(attempts: ProblemAttempt[]) {
  const rates = attempts
    .filter((attempt) => attempt.maxScore > 0)
    .map((attempt) => (attempt.earnedScore / attempt.maxScore) * 100);
  return rates.length === 0 ? null : round1(rates.reduce((sum, rate) => sum + rate, 0) / rates.length);
}

function percentage(current: number, target: number) {
  return target > 0 ? round1((current / target) * 100) : null;
}

function round1(value: number) {
  return Math.round((value + Number.EPSILON) * 10) / 10;
}
