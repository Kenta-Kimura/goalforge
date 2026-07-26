import { xpRules } from "../data/sampleData";
import type { Activity, ActivityType, Goal, ManualEntryDraft } from "../types";

export interface XpBreakdownItem {
  type: ActivityType;
  amount: number;
  xpPerUnit: number;
  xp: number;
}

export function calculateActivityXp(activity: Pick<Activity, "type" | "amount">) {
  const rule = xpRules.find((item) => item.type === activity.type);
  return (rule?.xpPerUnit ?? 0) * activity.amount;
}

export function calculateXpBreakdown(goal: Goal, activities: Activity[]): XpBreakdownItem[] {
  const goalActivities = activities.filter((activity) => activity.goalId === goal.id);

  return xpRules.map((rule) => {
    const amount = goalActivities
      .filter((activity) => activity.type === rule.type)
      .reduce((sum, activity) => sum + activity.amount, 0);

    return {
      type: rule.type,
      amount,
      xpPerUnit: rule.xpPerUnit,
      xp: amount * rule.xpPerUnit,
    };
  });
}

export function calculateTotalXp(goal: Goal, activities: Activity[]) {
  return activities
    .filter((activity) => activity.goalId === goal.id)
    .reduce((sum, activity) => sum + calculateActivityXp(activity), goal.xp);
}

export function calculateLevel(xp: number) {
  return Math.max(1, Math.floor(Math.sqrt(xp / 12)) + 1);
}

export function nextLevelXp(level: number) {
  return Math.pow(level, 2) * 12;
}

export function calculateReadiness(goal: Goal, currentXp: number, skillAverage: number) {
  const xpReadiness = Math.min(100, Math.round((currentXp / goal.targetXp) * 100));
  return Math.round(xpReadiness * 0.45 + skillAverage * 0.55);
}

export function manualDraftToActivities(
  goalId: string,
  sourceId: string,
  draft: ManualEntryDraft,
): Activity[] {
  const now = new Date().toISOString();
  const items: Array<[ActivityType, number, Partial<Activity>?]> = [
    ["textbookPage", draft.textbookPages],
    ["exercise", draft.exerciseCount, { correct: draft.correctCount }],
    ["mockExam", draft.mockExamScore > 0 ? 1 : 0, { score: draft.mockExamScore }],
    ["listeningMinute", draft.listeningMinutes],
    ["readAloud", draft.readAloudCount],
  ];

  return items
    .filter(([, amount]) => amount > 0)
    .map(([type, amount, extra], index) => ({
      id: `manual-${Date.now()}-${index}`,
      goalId,
      sourceId,
      type,
      amount,
      occurredAt: now,
      ...extra,
    }));
}
