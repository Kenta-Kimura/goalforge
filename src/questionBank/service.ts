import type { QuestionBankRepository } from "./repository";
import type {
  CreateAttemptInput,
  EvaluationType,
  ProblemEvaluationType,
  ProblemReviewStatus,
  QuestionBank,
} from "./types";

export class QuestionBankService {
  constructor(private readonly repository: QuestionBankRepository) {}

  list() {
    return this.repository.findAll();
  }

  async createBank(title: string, materialId: string) {
    const normalizedTitle = title.trim();
    if (!normalizedTitle) throw new Error("問題集名を入力してください。");
    const bank: QuestionBank = {
      id: crypto.randomUUID(),
      materialId,
      title: normalizedTitle,
      sections: [],
      rounds: [],
    };
    return this.repository.save(bank);
  }

  createMaterial(title: string, _goalId?: string) {
    return this.createBank(title, crypto.randomUUID());
  }

  renameMaterial(material: QuestionBank, title: string) {
    return this.renameBank(material, title);
  }

  deleteMaterial(id: string) {
    return this.deleteBank(id);
  }

  async addSection(
    bank: QuestionBank,
    input: { title: string; evaluationType: EvaluationType; isMockExamSection: boolean },
  ) {
    if (!input.title.trim()) throw new Error("大問名を入力してください。");
    return this.repository.save({
      ...bank,
      sections: [
        ...bank.sections,
        {
          id: crypto.randomUUID(),
          questionBankId: bank.id,
          title: input.title.trim(),
          order: bank.sections.length,
          evaluationType: input.evaluationType,
          isMockExamSection: input.isMockExamSection,
          problems: [],
        },
      ],
    });
  }

  renameBank(bank: QuestionBank, title: string) {
    if (!title.trim()) throw new Error("問題集名を入力してください。");
    return this.repository.save({ ...bank, title: title.trim() });
  }

  deleteBank(id: string) {
    return this.repository.delete(id);
  }

  updateSection(bank: QuestionBank, sectionId: string, input: { title: string; evaluationType?: EvaluationType }) {
    if (!input.title.trim()) throw new Error("大問名を入力してください。");
    return this.repository.save({
      ...bank,
      sections: bank.sections.map((section) =>
        section.id === sectionId
          ? { ...section, title: input.title.trim(), evaluationType: input.evaluationType ?? section.evaluationType }
          : section,
      ),
    });
  }

  deleteSection(id: string) {
    return this.repository.deleteSection(id);
  }

  async addProblems(
    bank: QuestionBank,
    sectionId: string,
    input: { count: number; defaultMaxScore: number; evaluationTypeOverride?: ProblemEvaluationType },
  ) {
    if (!Number.isInteger(input.count) || input.count < 1 || input.count > 500) {
      throw new Error("問題数は1〜500の整数で入力してください。");
    }
    validateScore(0, input.defaultMaxScore);
    return this.repository.save({
      ...bank,
      sections: bank.sections.map((section) => {
        if (section.id !== sectionId) return section;
        const start = section.problems.length;
        return {
          ...section,
          problems: [
            ...section.problems,
            ...Array.from({ length: input.count }, (_, index) => ({
              id: crypto.randomUUID(),
              sectionId,
              number: String(start + index + 1),
              order: start + index,
              defaultMaxScore: input.defaultMaxScore,
              evaluationTypeOverride: input.evaluationTypeOverride,
              reviewStatus: "active" as const,
              attempts: [],
            })),
          ],
        };
      }),
    });
  }

  updateProblem(
    bank: QuestionBank,
    problemId: string,
    input: {
      number: string;
      title?: string;
      sectionId: string;
      evaluationTypeOverride?: ProblemEvaluationType;
      defaultMaxScore: number;
      supplementalInfo?: string;
    },
  ) {
    validateScore(0, input.defaultMaxScore);
    if (!input.number.trim()) throw new Error("問題番号を入力してください。");
    return this.repository.save({
      ...bank,
      sections: bank.sections.map((section) => {
        const existing = bank.sections.flatMap((item) => item.problems).find((problem) => problem.id === problemId);
        const remaining = section.problems.filter((problem) => problem.id !== problemId);
        if (!existing || section.id !== input.sectionId) return { ...section, problems: remaining };
        return {
          ...section,
          problems: [
            ...remaining,
            {
              ...existing,
              sectionId: input.sectionId,
              number: input.number.trim(),
              title: input.title?.trim() || undefined,
              evaluationTypeOverride: input.evaluationTypeOverride,
              defaultMaxScore: input.defaultMaxScore,
              supplementalInfo: input.supplementalInfo?.trim() || undefined,
            },
          ].sort((a, b) => a.order - b.order),
        };
      }),
    });
  }

  deleteProblem(id: string) {
    return this.repository.deleteProblem(id);
  }

  createRound(bankId: string, mode: "active" | "all" | "manual", problemIds?: string[]) {
    if (mode === "manual" && !problemIds?.length) throw new Error("対象問題を選択してください。");
    return this.repository.createRound(bankId, mode, problemIds);
  }

  recordAttempt(input: CreateAttemptInput) {
    validateScore(input.earnedScore, input.maxScore);
    return this.repository.createAttempt({
      ...input,
      id: input.id ?? crypto.randomUUID(),
      answeredAt: input.answeredAt ?? new Date().toISOString(),
      note: input.note?.trim() || undefined,
    });
  }

  updateAttempt(id: string, input: CreateAttemptInput) {
    validateScore(input.earnedScore, input.maxScore);
    return this.repository.updateAttempt(id, input);
  }

  deleteAttempt(id: string) {
    return this.repository.deleteAttempt(id);
  }

  updateStatuses(problemIds: string[], status: ProblemReviewStatus) {
    if (!problemIds.length) throw new Error("問題を選択してください。");
    return this.repository.updateProblemStatuses(problemIds, status);
  }

  completeRound(roundId: string) {
    return this.repository.completeRound(roundId);
  }
}

export function validateScore(earnedScore: number, maxScore: number) {
  if (!Number.isFinite(maxScore) || maxScore < 1) throw new Error("満点は1以上にしてください。");
  if (!Number.isFinite(earnedScore) || earnedScore < 0) throw new Error("獲得点は0以上にしてください。");
  if (earnedScore > maxScore) throw new Error("獲得点は満点以下にしてください。");
}
