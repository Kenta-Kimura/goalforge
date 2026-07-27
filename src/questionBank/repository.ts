import { invokeDesktop } from "../lib/tauri";
import type {
  CustomMetricDefinitionDto,
  CustomMetricSummary,
  CustomMetricWriteInput,
  RestoreDefaultMetricOutcome,
} from "./customMetrics";
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
  getCustomMetricSummaries(questionBankId: string): Promise<CustomMetricSummary[]>;
  listCustomMetrics(questionBankId: string): Promise<CustomMetricDefinitionDto[]>;
  createCustomMetric(
    questionBankId: string,
    input: CustomMetricWriteInput,
  ): Promise<CustomMetricDefinitionDto>;
  updateCustomMetric(metricId: string, input: CustomMetricWriteInput): Promise<CustomMetricDefinitionDto>;
  setCustomMetricVisibility(metricId: string, isVisible: boolean): Promise<CustomMetricDefinitionDto>;
  moveCustomMetric(metricId: string, newSortOrder: number): Promise<CustomMetricDefinitionDto[]>;
  deleteCustomMetric(metricId: string): Promise<void>;
  resetCustomMetrics(questionBankId: string): Promise<CustomMetricDefinitionDto[]>;
  restoreDefaultCustomMetric(
    questionBankId: string,
    systemKey: string,
  ): Promise<RestoreDefaultMetricOutcome>;
}

type DesktopInvoker = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

export class SqliteQuestionBankRepository implements QuestionBankRepository {
  constructor(private readonly invoke: DesktopInvoker = invokeDesktop) {}

  findAll() {
    return this.invoke<QuestionBank[]>("get_question_banks");
  }

  save(bank: QuestionBank) {
    return this.invoke<QuestionBank>("save_question_bank", { bank });
  }

  delete(id: string) {
    return this.invoke<void>("delete_question_bank", { id });
  }

  deleteSection(id: string) {
    return this.invoke<void>("delete_question_section", { id });
  }

  deleteProblem(id: string) {
    return this.invoke<void>("delete_problem", { id });
  }

  createRound(bankId: string, mode: "active" | "all" | "manual", problemIds: string[] = []) {
    return this.invoke<PracticeRound>("create_practice_round", { bankId, mode, problemIds });
  }

  completeRound(roundId: string) {
    return this.invoke<void>("complete_practice_round", { roundId });
  }

  createAttempt(input: CreateAttemptInput) {
    return this.invoke<ProblemAttempt>("create_attempt", { input });
  }

  updateAttempt(id: string, input: CreateAttemptInput) {
    return this.invoke<ProblemAttempt>("update_attempt", { id, input });
  }

  deleteAttempt(id: string) {
    return this.invoke<void>("delete_attempt", { id });
  }

  updateProblemStatuses(problemIds: string[], status: ProblemReviewStatus) {
    return this.invoke<void>("update_problem_statuses", { problemIds, status });
  }

  getCustomMetricSummaries(questionBankId: string) {
    return this.invoke<CustomMetricSummary[]>("get_custom_metric_summaries", {
      questionBankId,
    });
  }

  listCustomMetrics(questionBankId: string) {
    return this.invoke<CustomMetricDefinitionDto[]>("list_custom_metrics", {
      questionBankId,
    });
  }

  createCustomMetric(questionBankId: string, input: CustomMetricWriteInput) {
    return this.invoke<CustomMetricDefinitionDto>("create_custom_metric", {
      questionBankId,
      input,
    });
  }

  updateCustomMetric(metricId: string, input: CustomMetricWriteInput) {
    return this.invoke<CustomMetricDefinitionDto>("update_custom_metric", {
      metricId,
      input,
    });
  }

  setCustomMetricVisibility(metricId: string, isVisible: boolean) {
    return this.invoke<CustomMetricDefinitionDto>("set_custom_metric_visibility", {
      metricId,
      isVisible,
    });
  }

  moveCustomMetric(metricId: string, newSortOrder: number) {
    return this.invoke<CustomMetricDefinitionDto[]>("move_custom_metric", {
      metricId,
      newSortOrder,
    });
  }

  deleteCustomMetric(metricId: string) {
    return this.invoke<void>("delete_custom_metric", { metricId });
  }

  resetCustomMetrics(questionBankId: string) {
    return this.invoke<CustomMetricDefinitionDto[]>("reset_custom_metrics", {
      questionBankId,
    });
  }

  restoreDefaultCustomMetric(questionBankId: string, systemKey: string) {
    return this.invoke<RestoreDefaultMetricOutcome>("restore_default_custom_metric", {
      questionBankId,
      systemKey,
    });
  }
}
