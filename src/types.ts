export type GoalStatus = "active" | "planned" | "paused";

export type SourceType = "anki" | "manual" | "csv" | "mockExam";

export type ActivityType =
  | "ankiReview"
  | "ankiNew"
  | "textbookPage"
  | "exercise"
  | "mockExam"
  | "listeningMinute"
  | "readAloud";

export interface Goal {
  id: string;
  title: string;
  subtitle: string;
  status: GoalStatus;
  readiness: number;
  targetXp: number;
  xp: number;
  examDate?: string;
  skillIds: string[];
  collectionIds: string[];
}

export interface Skill {
  id: string;
  goalId: string;
  name: string;
  level: number;
  progress: number;
}

export interface CollectionCategory {
  id: string;
  goalId: string;
  name: string;
  level: number;
  collected: number;
  total: number;
}

export interface Source {
  id: string;
  goalId: string;
  type: SourceType;
  label: string;
}

export interface Activity {
  id: string;
  goalId: string;
  sourceId: string;
  type: ActivityType;
  amount: number;
  correct?: number;
  score?: number;
  occurredAt: string;
  note?: string;
}

export interface XpRule {
  type: ActivityType;
  xpPerUnit: number;
}

export type StudyResourceType = "anki" | "book" | "exam" | "audio" | "csv" | "manual" | "other";

export type StudyPlanPriority = "high" | "medium" | "low";

export type StudyResourceMergeMode = "create" | "update";

export type ResourceStartConditionType =
  | "none"
  | "immediate"
  | "manual"
  | "afterResourceStarted"
  | "afterResourceCompleted"
  | "afterResourceProgress"
  | "afterResourceAccuracy"
  | "afterResourceAmount"
  | "afterDate";

export interface ResourceStartCondition {
  type: ResourceStartConditionType;
  resourceId?: string;
  threshold?: number;
  date?: string;
  notes?: string;
}

export interface StudyResource {
  id: string;
  name: string;
  type: StudyResourceType;
  unit: string;
  targetAmount: number;
  currentAmount: number;
  weight: number;
  weeklyTarget: number;
  priority: StudyPlanPriority;
  startDate?: string;
  endDate?: string;
  notes: string;
  linkedDeckName?: string;
  startCondition?: ResourceStartCondition;
}

export interface StudyMilestone {
  date: string;
  title: string;
  description: string;
}

export interface XpRecommendation {
  currentTargetXp: number;
  recommendedTargetXp: number;
  reason: string;
}

export interface StudyPlan {
  id: string;
  goalId: string;
  planName: string;
  examDate: string;
  overallStrategy: string;
  resources: StudyResource[];
  milestones: StudyMilestone[];
  warnings: string[];
  xpRecommendation?: XpRecommendation;
  importedAt: string;
  resourceMergeModes: Record<string, StudyResourceMergeMode>;
}

export interface ImportedStudyPlan {
  goalId: string;
  planName: string;
  examDate: string;
  overallStrategy: string;
  resources: StudyResource[];
  milestones: StudyMilestone[];
  warnings: string[];
  xpRecommendation?: XpRecommendation;
}

export interface Quest {
  id: string;
  goalId: string;
  title: string;
  target: number;
  progress: number;
  unit: string;
  xp: number;
  sourceType: SourceType;
}

export interface CityReward {
  id: string;
  goalId: string;
  city: string;
  requiredXp: number;
  description: string;
}

export interface AnkiSyncData {
  deckNames: string[];
  targetDeckName?: string;
  targetDeckCardCount: number;
  totalReviewCount: number;
  totalLearnedCardCount: number;
  todayReviewCount: number;
  todayNewCount: number;
  cardSample: AnkiCardSummary[];
  noteSample: AnkiNoteSummary[];
  tags: string[];
  reviewHistory: AnkiReviewEntry[];
  syncedAt?: string;
}

export interface AnkiCardSummary {
  cardId: number;
  deckName: string;
  queue: number;
  type: number;
  interval: number;
  due: number;
}

export interface AnkiNoteSummary {
  noteId: number;
  tags: string[];
  fields: Record<string, string>;
}

export interface AnkiReviewEntry {
  cardId: number;
  reviews: unknown[];
}

export type SyncStatus = "idle" | "success" | "error";

export interface ManualEntryDraft {
  textbookPages: number;
  exerciseCount: number;
  correctCount: number;
  mockExamScore: number;
  listeningMinutes: number;
  readAloudCount: number;
}

export interface AppState {
  goals: Goal[];
  skills: Skill[];
  collections: CollectionCategory[];
  sources: Source[];
  activities: Activity[];
  quests: Quest[];
  cityRewards: CityReward[];
  studyPlans: StudyPlan[];
  anki: AnkiSyncData;
}
