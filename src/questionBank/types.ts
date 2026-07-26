export type EvaluationType = "binary" | "partial_score" | "mixed";
export type ProblemEvaluationType = "binary" | "partial_score";
export type ProblemReviewStatus = "active" | "completed" | "paused" | "excluded";
export type Confidence = "high" | "medium" | "low" | null;
export type ScoreResult = "correct" | "partial" | "incorrect";

export interface QuestionBank {
  id: string;
  materialId: string;
  title: string;
  sections: QuestionSection[];
  rounds: PracticeRound[];
}

export interface QuestionSection {
  id: string;
  questionBankId: string;
  title: string;
  order: number;
  evaluationType: EvaluationType;
  isMockExamSection: boolean;
  problems: Problem[];
}

export interface Problem {
  id: string;
  sectionId: string;
  number: string;
  title?: string;
  order: number;
  defaultMaxScore: number;
  evaluationTypeOverride?: ProblemEvaluationType;
  supplementalInfo?: string;
  reviewStatus: ProblemReviewStatus;
  attempts: ProblemAttempt[];
}

export interface ProblemAttempt {
  id: string;
  problemId: string;
  roundId: string;
  answeredAt: string;
  earnedScore: number;
  maxScore: number;
  confidence: Confidence;
  note?: string;
}

export interface PracticeRound {
  id: string;
  questionBankId: string;
  roundNumber: number;
  title?: string;
  startedAt: string;
  completedAt?: string;
  targetProblemIds: string[];
}

export interface CreateAttemptInput {
  id?: string;
  problemId: string;
  roundId: string;
  answeredAt?: string;
  earnedScore: number;
  maxScore: number;
  confidence: Confidence;
  note?: string;
  nextReviewStatus?: "active" | "completed";
}

export type QuestionFilter =
  | "all"
  | ProblemReviewStatus
  | "unanswered"
  | "incorrect"
  | "partial"
  | "unsure"
  | "confident_incorrect";
