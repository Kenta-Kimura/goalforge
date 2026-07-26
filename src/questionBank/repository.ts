import { invokeDesktop } from "../lib/tauri";
import type {
  CreateAttemptInput,
  PracticeRound,
  ProblemAttempt,
  ProblemReviewStatus,
  QuestionBank,
} from "./types";

export interface QuestionBankRepository {
  findAll(): Promise<QuestionBank[]>;
  save(bank: QuestionBank): Promise<QuestionBank>;
  delete(id: string): Promise<void>;
  deleteSection(id: string): Promise<void>;
  deleteProblem(id: string): Promise<void>;
  createRound(bankId: string, mode: "active" | "all" | "manual", problemIds?: string[]): Promise<PracticeRound>;
  completeRound(roundId: string): Promise<void>;
  createAttempt(input: CreateAttemptInput): Promise<ProblemAttempt>;
  updateAttempt(id: string, input: CreateAttemptInput): Promise<ProblemAttempt>;
  deleteAttempt(id: string): Promise<void>;
  updateProblemStatuses(problemIds: string[], status: ProblemReviewStatus): Promise<void>;
}

export class SqliteQuestionBankRepository implements QuestionBankRepository {
  findAll() {
    return invokeDesktop<QuestionBank[]>("get_question_banks");
  }

  save(bank: QuestionBank) {
    return invokeDesktop<QuestionBank>("save_question_bank", { bank });
  }

  delete(id: string) {
    return invokeDesktop<void>("delete_question_bank", { id });
  }

  deleteSection(id: string) {
    return invokeDesktop<void>("delete_question_section", { id });
  }

  deleteProblem(id: string) {
    return invokeDesktop<void>("delete_problem", { id });
  }

  createRound(bankId: string, mode: "active" | "all" | "manual", problemIds: string[] = []) {
    return invokeDesktop<PracticeRound>("create_practice_round", { bankId, mode, problemIds });
  }

  completeRound(roundId: string) {
    return invokeDesktop<void>("complete_practice_round", { roundId });
  }

  createAttempt(input: CreateAttemptInput) {
    return invokeDesktop<ProblemAttempt>("create_attempt", { input });
  }

  updateAttempt(id: string, input: CreateAttemptInput) {
    return invokeDesktop<ProblemAttempt>("update_attempt", { id, input });
  }

  deleteAttempt(id: string) {
    return invokeDesktop<void>("delete_attempt", { id });
  }

  updateProblemStatuses(problemIds: string[], status: ProblemReviewStatus) {
    return invokeDesktop<void>("update_problem_statuses", { problemIds, status });
  }
}
