import type {
  ActivityType,
  AnkiSyncData,
  Goal,
  ImportedStudyPlan,
  ResourceStartCondition,
  StudyPlan,
  StudyResource,
  StudyResourceMergeMode,
  XpRecommendation,
} from "../types";

export interface StudyPlanValidationResult {
  plan?: ImportedStudyPlan;
  errors: string[];
  warnings: string[];
  errorType?: "parse" | "schema";
}

export interface ResourcePace {
  resource: StudyResource;
  scheduledProgress: number;
  currentProgress: number;
  difference: number;
  status: "順調" | "少し遅れ" | "遅れ" | "大幅遅れ";
}

interface PromptXpBreakdownItem {
  type: ActivityType;
  amount: number;
  xpPerUnit: number;
  xp: number;
}

const priorityValues = new Set(["high", "medium", "low"]);
const resourceTypes = new Set(["anki", "book", "exam", "audio", "csv", "manual", "other"]);
const startConditionTypes = new Set([
  "none",
  "immediate",
  "manual",
  "afterResourceStarted",
  "afterResourceCompleted",
  "afterResourceProgress",
  "afterResourceAccuracy",
  "afterResourceAmount",
  "afterDate",
]);

const xpPromptLabels: Record<ActivityType, string> = {
  ankiReview: "Ankiレビュー",
  ankiNew: "Anki新規",
  textbookPage: "テキスト",
  exercise: "問題演習",
  mockExam: "模試",
  listeningMinute: "リスニング",
  readAloud: "音読",
};

export function daysUntil(date?: string) {
  if (!date) return undefined;
  const today = new Date();
  const target = new Date(`${date}T00:00:00`);
  const diff = target.getTime() - new Date(today.toDateString()).getTime();
  return Math.ceil(diff / 86_400_000);
}

function todayDateString() {
  return new Date().toLocaleDateString("en-CA");
}

export function generateStudyPlanPrompt({
  goal,
  anki,
  existingPlan,
  memo,
  currentXp,
  xpBreakdown,
}: {
  goal: Goal;
  anki: AnkiSyncData;
  existingPlan?: StudyPlan;
  memo: string;
  currentXp: number;
  xpBreakdown: PromptXpBreakdownItem[];
}) {
  const resources = existingPlan?.resources ?? [];
  const resourceLines = resources.length
    ? resources
        .map(
          (resource) =>
            `- ${resource.name}: ${resource.currentAmount}/${resource.targetAmount} ${resource.unit}, type=${resource.type}, weight=${resource.weight}, weeklyTarget=${resource.weeklyTarget}, priority=${resource.priority}, startDate=${resource.startDate ?? "未設定"}, endDate=${resource.endDate ?? "未設定"}${resource.startCondition ? `\n  開始条件: ${formatStartCondition(resource.startCondition, resources)}` : ""}`,
        )
        .join("\n")
    : "- 現在登録されている教材はありません。必要な教材を提案してください。";

  const ankiLine = anki.targetDeckName
    ? `- 対象デッキ: ${anki.targetDeckName}
- 前回同期時の対象デッキカード数: ${anki.targetDeckCardCount}
- 前回同期日時: ${anki.syncedAt ?? "未同期"}
- 注意: このAnki情報はGoalForgeに保存されている前回同期データです。`
    : "- Anki連携データは未取得です。";

  const today = todayDateString();
  const xpLines = xpBreakdown.length
    ? xpBreakdown
        .map(
          (item) =>
            `- ${xpPromptLabels[item.type]}: ${item.amount} × ${item.xpPerUnit}XP = ${item.xp}XP`,
        )
        .join("\n")
    : "- 記録済みXPはありません。";

  return `あなたは学習計画を作るコーチです。以下のGoalForgeデータをもとに、試験日までに現実的に完了できる学習計画を作成してください。

## 学習目標
- goalId: ${goal.id}
- 学習目標名: ${goal.title}
- 試験日: ${goal.examDate ?? "未設定"}
- 今日の日付: ${today}
- 目標XP: ${goal.targetXp}
- 現在XP: ${currentXp}
- 注意: goalId はGoalForgeの内部IDです。出力JSONでは必ず "${goal.id}" のまま返し、変更しないでください。

## XP状況
- 現在GoalForgeで設定されている目標XP: ${goal.targetXp}
- 現在XP: ${currentXp}
XPはモチベーション指標です。試験日までに間に合うかの判定は、XPではなく教材ごとの進捗率と重要度を主指標にしてください。
教材量・試験日・現在進捗・現在XPから、現在の目標XPが妥当か確認し、必要なら推奨目標XPを提案してください。
${xpLines}

## 現在登録されている教材一覧
${resourceLines}

## Anki連携状況
${ankiLine}

## ユーザー補足メモ
${memo || "なし"}

## 依頼内容
- 試験日までに現実的な学習計画を作る
- 教材ごとの目標量を提案する
- 教材ごとの重要度を提案する
- 教材ごとの週あたり必要ペースを提案する
- 教材ごとの優先度を提案する
- 教材ごとの開始日と終了日を提案する
- 教材の開始条件や順序関係が現実的か確認し、必要なら補足する
- 目標XPが妥当か確認し、現在XPも参考にして推奨目標XPと理由を提案する
- 足りない教材や学習項目があれば追加提案する
- goalId は必ず "${goal.id}" にする
- 必ずJSONのみで出力する
- Markdownコードブロックや説明文は出力しない

## 出力JSON形式
{
  "goalId": "${goal.id}",
  "planName": "${goal.title} 学習計画",
  "examDate": "${goal.examDate ?? "YYYY-MM-DD"}",
  "overallStrategy": "全体方針を1文から3文で書く。",
  "xpRecommendation": {
    "currentTargetXp": ${goal.targetXp},
    "recommendedTargetXp": ${goal.targetXp},
    "reason": "教材量・試験日・現在進捗から見た目標XPの妥当性を書く。"
  },
  "resources": [
    {
      "id": "resource-id",
      "name": "教材名",
      "type": "book",
      "unit": "pages",
      "targetAmount": 100,
      "currentAmount": 0,
      "weight": 25,
      "weeklyTarget": 10,
      "priority": "high",
      "startDate": "${today}",
      "endDate": "${goal.examDate ?? "YYYY-MM-DD"}",
      "notes": "教材への取り組み方",
      "startCondition": {
        "type": "afterResourceProgress",
        "resourceId": "previous-resource-id",
        "threshold": 80,
        "notes": "前提教材が80%以上完了してから開始"
      }
    }
  ],
  "milestones": [
    {
      "date": "${goal.examDate ?? "YYYY-MM-DD"}",
      "title": "マイルストーン名",
      "description": "達成条件"
    }
  ],
  "warnings": [
    "注意点"
  ]
}`;
}

export function validateStudyPlanJson(
  input: string,
  goal: Goal,
  existingPlan?: StudyPlan,
): StudyPlanValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  let parsed: unknown;

  try {
    parsed = JSON.parse(sanitizeJsonInput(input));
  } catch {
    return {
      errors: ["JSONとして正しくありません。カンマ、引用符、波括弧の対応を確認してください。"],
      warnings,
      errorType: "parse",
    };
  }

  if (!parsed || typeof parsed !== "object") {
    return {
      errors: [
        "JSON形式は正しいですが、GoalForgeの取り込み形式に合っていません。",
        "JSONのルートはオブジェクトにしてください。",
      ],
      warnings,
      errorType: "schema",
    };
  }

  const raw = parsed as Record<string, unknown>;
  if (!Array.isArray(raw.resources)) {
    errors.push("resources は配列である必要があります。");
  }

  const importedGoalId = stringValue(raw.goalId);
  if (importedGoalId && importedGoalId !== goal.id) {
    errors.push(`goalId は現在の学習目標 ${goal.id} と一致させてください。現在は ${importedGoalId} です。`);
  }

  const resources = Array.isArray(raw.resources)
    ? raw.resources.map((resource, index) => normalizeResource(resource, index, errors, warnings))
    : [];
  const examDate = stringValue(raw.examDate) || goal.examDate || "";
  fillMissingResourceDates(resources, examDate);
  warnResourceMatches(resources, existingPlan, warnings);

  const weightTotal = resources.reduce((sum, resource) => sum + resource.weight, 0);
  if (weightTotal < 90 || weightTotal > 110) {
    warnings.push(`weight の合計は100前後ではありません。現在は ${weightTotal} です。取り込みは続行できます。`);
  }

  if (!examDate) {
    warnings.push("examDate が未設定です。学習目標にも試験日がないため、ペース管理の基準日を後で設定してください。");
  } else if (goal.examDate) {
    const diffDays = Math.abs(new Date(examDate).getTime() - new Date(goal.examDate).getTime()) / 86_400_000;
    if (diffDays > 7) {
      warnings.push(`examDate がGoalの試験日 ${goal.examDate} と大きく異なります。取り込み後に確認してください。`);
    } else if (diffDays > 0) {
      warnings.push(`examDate がGoalの試験日 ${goal.examDate} と少し異なります。`);
    }
  }

  const planName = stringValue(raw.planName) || `${goal.title} 学習計画`;
  const overallStrategy = stringValue(raw.overallStrategy) || "";
  const milestones = Array.isArray(raw.milestones)
    ? raw.milestones.map(normalizeMilestone).filter((milestone) => milestone !== undefined)
    : [];
  const rawWarnings = Array.isArray(raw.warnings) ? raw.warnings.map(String) : [];
  const xpRecommendation = normalizeXpRecommendation(raw.xpRecommendation);

  if (errors.length) {
    return {
      errors: ["JSON形式は正しいですが、GoalForgeの取り込み形式に合っていません。", ...errors],
      warnings,
      errorType: "schema",
    };
  }

  return {
    errors,
    warnings,
    plan: {
      goalId: stringValue(raw.goalId) || goal.id,
      planName,
      examDate,
      overallStrategy,
      resources,
      milestones,
      warnings: rawWarnings,
      xpRecommendation,
    },
  };
}

function warnResourceMatches(
  resources: StudyResource[],
  existingPlan: StudyPlan | undefined,
  warnings: string[],
) {
  const existingResources = existingPlan?.resources ?? [];
  if (!existingResources.length) {
    if (resources.length) {
      warnings.push("GoalForgeに登録済み教材がないため、resources は新規教材として取り込みます。");
    }
    return;
  }

  for (const [index, resource] of resources.entries()) {
    const idMatch = existingResources.find((item) => item.id === resource.id);
    const nameMatch = findSimilarResource(resource.name, existingResources);
    if (idMatch) continue;
    if (nameMatch) {
      warnings.push(
        `resources[${index}].id "${resource.id}" は既存教材IDと一致しませんが、name "${resource.name}" で "${nameMatch.name}" と照合できます。`,
      );
      continue;
    }
    warnings.push(`resources[${index}] "${resource.name}" はGoalForge未登録の追加教材として取り込みます。`);
  }
}

export function sanitizeJsonInput(input: string) {
  const withoutBom = input.replace(/^\uFEFF/, "").trim();
  const fenced = withoutBom.match(/^```(?:json|JSON)?\s*([\s\S]*?)\s*```$/);
  return (fenced ? fenced[1] : withoutBom).replace(/^\uFEFF/, "").trim();
}

export function toStudyPlan(
  importedPlan: ImportedStudyPlan,
  goalId: string,
  existingPlan?: StudyPlan,
  mergeModes: Record<string, StudyResourceMergeMode> = {},
): StudyPlan {
  const existingResources = existingPlan?.resources ?? [];
  const importedAt = new Date().toISOString();
  const resources = importedPlan.resources.map((resource) => {
    const match = findSimilarResource(resource.name, existingResources);
    if (match && mergeModes[resource.id] === "update") {
      return { ...resource, id: match.id };
    }
    return resource;
  });
  fillMissingResourceDates(resources, importedPlan.examDate, importedAt);

  return {
    id: existingPlan?.id ?? `plan-${goalId}-${Date.now()}`,
    goalId,
    planName: importedPlan.planName,
    examDate: importedPlan.examDate,
    overallStrategy: importedPlan.overallStrategy,
    resources,
    milestones: importedPlan.milestones,
    warnings: importedPlan.warnings,
    xpRecommendation: importedPlan.xpRecommendation,
    importedAt,
    resourceMergeModes: mergeModes,
  };
}

export function findSimilarResource(name: string, resources: StudyResource[]) {
  const normalizedName = normalizeName(name);
  return resources.find((resource) => {
    const existing = normalizeName(resource.name);
    return existing === normalizedName || existing.includes(normalizedName) || normalizedName.includes(existing);
  });
}

export function calculateResourcePaces(plan: StudyPlan): ResourcePace[] {
  return plan.resources.map((resource) => {
    const scheduledProgress = calculateResourceScheduledProgress(plan, resource);
    const currentProgress = Math.min(100, Math.round((resource.currentAmount / resource.targetAmount) * 100));
    const difference = currentProgress - scheduledProgress;
    return {
      resource,
      scheduledProgress,
      currentProgress,
      difference,
      status: paceStatus(difference),
    };
  });
}

export function calculateResourceScheduledProgress(plan: StudyPlan, resource: StudyResource) {
  const start = parseDateValue(resource.startDate ?? plan.importedAt);
  const end = parseDateValue(resource.endDate ?? plan.examDate);
  const now = new Date();
  const total = end.getTime() - start.getTime();
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return calculateScheduledProgress(plan);
  if (total <= 0) return 100;
  return Math.min(100, Math.max(0, Math.round(((now.getTime() - start.getTime()) / total) * 100)));
}

export function calculatePlanReadiness(plan?: StudyPlan) {
  if (!plan || !plan.resources.length) return 0;
  const totalWeight = plan.resources.reduce((sum, resource) => sum + resource.weight, 0);
  if (totalWeight <= 0) return 0;
  return Math.round(
    plan.resources.reduce((sum, resource) => {
      const progress = Math.min(100, (resource.currentAmount / resource.targetAmount) * 100);
      return sum + progress * resource.weight;
    }, 0) / totalWeight,
  );
}

export function calculateScheduledProgress(plan: StudyPlan) {
  const start = new Date(plan.importedAt);
  const end = new Date(`${plan.examDate}T00:00:00`);
  const now = new Date();
  const total = end.getTime() - start.getTime();
  if (total <= 0) return 100;
  return Math.min(100, Math.max(0, Math.round(((now.getTime() - start.getTime()) / total) * 100)));
}

function paceStatus(difference: number): ResourcePace["status"] {
  if (difference >= 0) return "順調";
  if (difference >= -10) return "少し遅れ";
  if (difference >= -25) return "遅れ";
  return "大幅遅れ";
}

function normalizeResource(resource: unknown, index: number, errors: string[], warnings: string[]): StudyResource {
  const raw = resource && typeof resource === "object" ? (resource as Record<string, unknown>) : {};
  const name = stringValue(raw.name);
  const type = stringValue(raw.type);
  const unit = stringValue(raw.unit);
  const targetAmount = numberValue(raw.targetAmount);
  const currentAmount = numberValue(raw.currentAmount);
  const weight = numberValue(raw.weight);
  const weeklyTarget = numberValue(raw.weeklyTarget);
  const normalizedType = normalizeResourceType(type, index, warnings);
  const normalizedWeight = normalizeWeight(weight, index, warnings);
  const normalizedPriority = normalizePriority(raw.priority, index, warnings);
  const normalizedWeeklyTarget = normalizeWeeklyTarget(weeklyTarget, index, warnings);

  if (!name) errors.push(`resources[${index}].name が必要です。`);
  if (!type) warnings.push(`resources[${index}].type が未設定です。other として取り込みます。`);
  if (!unit) errors.push(`resources[${index}].unit が必要です。`);
  if (!Number.isFinite(targetAmount) || targetAmount <= 0) {
    errors.push(`resources[${index}].targetAmount は0より大きい数値にしてください。`);
  }

  return {
    id: stringValue(raw.id) || slugify(name || `resource-${index + 1}`),
    name,
    type: normalizedType,
    unit,
    targetAmount,
    currentAmount: Number.isFinite(currentAmount) ? currentAmount : 0,
    weight: normalizedWeight,
    weeklyTarget: normalizedWeeklyTarget,
    priority: normalizedPriority,
    startDate: normalizeDate(raw.startDate),
    endDate: normalizeDate(raw.endDate),
    notes: stringValue(raw.notes),
    linkedDeckName: stringValue(raw.linkedDeckName) || undefined,
    startCondition: normalizeStartCondition(raw.startCondition, index, warnings),
  };
}

function fillMissingResourceDates(resources: StudyResource[], examDate: string, importedAt = new Date().toISOString()) {
  if (!resources.length) return;
  const start = normalizeDate(importedAt) || todayDateString();
  const end = normalizeDate(examDate) || start;
  const startDate = new Date(`${start}T00:00:00`);
  const endDate = new Date(`${end}T00:00:00`);
  const span = Math.max(1, endDate.getTime() - startDate.getTime());

  resources.forEach((resource, index) => {
    if (resource.startDate && resource.endDate) return;
    const resourceStart = new Date(startDate.getTime() + (span * index) / resources.length);
    const resourceEnd = new Date(startDate.getTime() + (span * (index + 1)) / resources.length);
    resource.startDate = resource.startDate || toDateInputValue(resourceStart);
    resource.endDate = resource.endDate || toDateInputValue(resourceEnd);
  });
}

function toDateInputValue(date: Date) {
  if (Number.isNaN(date.getTime())) return todayDateString();
  return date.toLocaleDateString("en-CA");
}

function normalizeResourceType(type: string, index: number, warnings: string[]): StudyResource["type"] {
  if (resourceTypes.has(type)) return type as StudyResource["type"];
  if (!type) return "other";

  const lowered = type.toLowerCase();
  const aliases: Record<string, StudyResource["type"]> = {
    textbook: "book",
    text: "book",
    workbook: "book",
    problem: "manual",
    questions: "manual",
    practice: "manual",
    mock: "exam",
    test: "exam",
    listening: "audio",
    video: "other",
    custom: "other",
  };
  const mapped = aliases[lowered] ?? "other";
  warnings.push(`resources[${index}].type の値 "${type}" は ${mapped} として取り込みます。`);
  return mapped;
}

function normalizeWeight(weight: number, index: number, warnings: string[]) {
  if (!Number.isFinite(weight)) {
    warnings.push(`resources[${index}].weight が数値ではありません。0として取り込みます。`);
    return 0;
  }
  if (weight < 0 || weight > 100) {
    const clamped = Math.min(100, Math.max(0, weight));
    warnings.push(`resources[${index}].weight は0〜100の範囲外です。${clamped}として取り込みます。`);
    return clamped;
  }
  return weight;
}

function normalizePriority(priority: unknown, index: number, warnings: string[]): StudyResource["priority"] {
  const value = stringValue(priority);
  if (priorityValues.has(value)) return value as StudyResource["priority"];
  if (!value) {
    if (priority !== undefined && priority !== null && priority !== "") {
      warnings.push(`resources[${index}].priority は high / medium / low の文字列ではありません。medium として取り込みます。`);
    }
    return "medium";
  }
  warnings.push(`resources[${index}].priority の値 "${value}" は未対応です。medium として取り込みます。`);
  return "medium";
}

function normalizeWeeklyTarget(weeklyTarget: number, index: number, warnings: string[]) {
  if (!Number.isFinite(weeklyTarget)) {
    warnings.push(`resources[${index}].weeklyTarget が数値ではありません。0として取り込みます。`);
    return 0;
  }
  if (weeklyTarget < 0) {
    warnings.push(`resources[${index}].weeklyTarget が0未満です。0として取り込みます。`);
    return 0;
  }
  return weeklyTarget;
}

function normalizeStartCondition(
  condition: unknown,
  index: number,
  warnings: string[],
): ResourceStartCondition | undefined {
  if (!condition || typeof condition !== "object") return undefined;
  const raw = condition as Record<string, unknown>;
  const type = stringValue(raw.type);
  if (!type || type === "none" || type === "immediate") return undefined;
  if (type === "manual") {
    return {
      type: "manual",
      notes: stringValue(raw.notes) || undefined,
    };
  }
  if (!startConditionTypes.has(type)) {
    warnings.push(`resources[${index}].startCondition.type の値 "${type}" は未対応です。開始条件なしとして取り込みます。`);
    return undefined;
  }

  const resourceId = stringValue(raw.resourceId) || undefined;
  if (
    !resourceId &&
    (type === "afterResourceStarted" ||
      type === "afterResourceCompleted" ||
      type === "afterResourceProgress" ||
      type === "afterResourceAccuracy" ||
      type === "afterResourceAmount")
  ) {
    warnings.push(`resources[${index}].startCondition.resourceId が空です。開始条件は残しますが、対象教材は未指定になります。`);
  }

  return {
    type: type as ResourceStartCondition["type"],
    resourceId,
    threshold: Number.isFinite(numberValue(raw.threshold)) ? numberValue(raw.threshold) : undefined,
    date: stringValue(raw.date) || undefined,
    notes: stringValue(raw.notes) || undefined,
  };
}

function normalizeXpRecommendation(value: unknown): XpRecommendation | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  const currentTargetXp = numberValue(raw.currentTargetXp);
  const recommendedTargetXp = numberValue(raw.recommendedTargetXp);

  if (!Number.isFinite(recommendedTargetXp) || recommendedTargetXp <= 0) {
    return undefined;
  }

  return {
    currentTargetXp: Number.isFinite(currentTargetXp) ? currentTargetXp : 0,
    recommendedTargetXp,
    reason: stringValue(raw.reason),
  };
}

function formatStartCondition(condition: ResourceStartCondition, resources: StudyResource[]) {
  const resourceName = condition.resourceId
    ? resources.find((resource) => resource.id === condition.resourceId)?.name ?? condition.resourceId
    : "対象教材未指定";
  const threshold = condition.threshold ?? 0;

  switch (condition.type) {
    case "afterResourceStarted":
      return `${resourceName} を開始後`;
    case "afterResourceCompleted":
      return `${resourceName} を完了後`;
    case "afterResourceProgress":
      return `${resourceName} が ${threshold}% 以上完了後`;
    case "afterResourceAccuracy":
      return `${resourceName} が ${threshold}% 以上正解後`;
    case "afterResourceAmount":
      return `${resourceName} が ${threshold} 以上になった後`;
    case "afterDate":
      return `${condition.date ?? "日付未指定"} 以降`;
    case "manual":
      return condition.notes ?? "手動で開始判断";
    default:
      return condition.notes ?? "条件なし";
  }
}

function normalizeMilestone(milestone: unknown) {
  if (!milestone || typeof milestone !== "object") return undefined;
  const raw = milestone as Record<string, unknown>;
  return {
    date: stringValue(raw.date),
    title: stringValue(raw.title),
    description: stringValue(raw.description),
  };
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeDate(value: unknown) {
  const text = stringValue(value);
  if (!text) return undefined;
  const date = parseDateValue(text);
  if (Number.isNaN(date.getTime())) return undefined;
  return date.toLocaleDateString("en-CA");
}

function parseDateValue(value: string) {
  return new Date(value.includes("T") ? value : `${value}T00:00:00`);
}

function numberValue(value: unknown) {
  return typeof value === "number" ? value : Number(value);
}

function normalizeName(value: string) {
  return value.toLowerCase().replace(/\s+/g, "").replace(/[・/／:_-]/g, "");
}

function slugify(value: string) {
  return normalizeName(value).replace(/[^\w\u3040-\u30ff\u3400-\u9fff]+/g, "-") || `resource-${Date.now()}`;
}
