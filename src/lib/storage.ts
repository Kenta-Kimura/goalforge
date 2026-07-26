import { initialState } from "../data/sampleData";
import type { AppState } from "../types";
import { invokeDesktop, isTauriRuntime } from "./tauri";

const STORAGE_KEY = "goalforge.appState.v2";
const BACKUP_VERSION = 1;

interface BackupFile {
  app: "GoalForge";
  version: number;
  exportedAt: string;
  state: AppState;
}

export function loadState(): AppState {
  return initialState;
}

export async function initializeState(): Promise<{ state: AppState; message?: string }> {
  if (!isTauriRuntime()) return { state: initialState };
  const saved = await invokeDesktop<AppState | null>("load_app_state");
  if (saved) return { state: removeDeprecatedSampleData({ ...initialState, ...saved }) };

  const legacyJson = window.localStorage.getItem(STORAGE_KEY);
  if (legacyJson) {
    const legacy = removeDeprecatedSampleData({ ...initialState, ...JSON.parse(legacyJson) } as AppState);
    const result = await invokeDesktop<{ message: string }>("migrate_legacy_state", { state: legacy });
    return { state: legacy, message: result.message };
  }

  await invokeDesktop("save_app_state", { state: initialState });
  return { state: initialState };
}

export async function saveState(state: AppState) {
  if (!isTauriRuntime()) return;
  await invokeDesktop("save_app_state", { state });
}

export async function getDatabaseInfo() {
  if (!isTauriRuntime()) return null;
  return invokeDesktop<{ path: string; schemaVersion: number }>("database_info");
}

export function createBackupJson(state: AppState) {
  const backup: BackupFile = {
    app: "GoalForge",
    version: BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    state,
  };

  return JSON.stringify(backup, null, 2);
}

export function parseBackupJson(input: string): AppState {
  const parsed = JSON.parse(input) as Partial<BackupFile> | AppState;

  if (isBackupFile(parsed)) {
    return removeDeprecatedSampleData({ ...initialState, ...parsed.state });
  }

  return removeDeprecatedSampleData({ ...initialState, ...(parsed as AppState) });
}

function isBackupFile(value: Partial<BackupFile> | AppState): value is BackupFile {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    "app" in value &&
    value.app === "GoalForge" &&
    "state" in value &&
    Boolean(value.state)
  );
}

function removeDeprecatedSampleData(state: AppState): AppState {
  return {
    ...state,
    studyPlans: hydrateStudyPlans(state.studyPlans ?? []),
    goals: state.goals.map((goal) =>
      goal.id === "chuken-2" ? { ...goal, readiness: 0, xp: 0 } : goal,
    ),
    skills: state.skills.map((skill) =>
      skill.goalId === "chuken-2" ? { ...skill, level: 1, progress: 0 } : skill,
    ),
    collections: state.collections.map((collection) =>
      collection.goalId === "chuken-2"
        ? { ...collection, level: 1, collected: 0 }
        : collection,
    ),
    anki: { ...initialState.anki, ...state.anki },
    sources: mergeSources(state.sources),
    activities: state.activities.filter((activity) => !activity.id.startsWith("seed-")),
  };
}

function hydrateStudyPlans(studyPlans: AppState["studyPlans"]) {
  return studyPlans.map((plan) => {
    if (!plan.resources.length) return plan;

    const planStart = toDateValue(plan.importedAt);
    const planEnd = toDateValue(plan.examDate);
    const startDate = new Date(`${planStart}T00:00:00`);
    const endDate = new Date(`${planEnd}T00:00:00`);
    const span = Math.max(1, endDate.getTime() - startDate.getTime());

    return {
      ...plan,
      resources: plan.resources.map((resource, index) => {
        if (resource.startDate && resource.endDate) return resource;
        const resourceStart = new Date(startDate.getTime() + (span * index) / plan.resources.length);
        const resourceEnd = new Date(startDate.getTime() + (span * (index + 1)) / plan.resources.length);
        return {
          ...resource,
          startDate: resource.startDate || toDateValue(resourceStart.toISOString()),
          endDate: resource.endDate || toDateValue(resourceEnd.toISOString()),
        };
      }),
    };
  });
}

function toDateValue(value: string) {
  const date = new Date(value.includes("T") ? value : `${value}T00:00:00`);
  if (Number.isNaN(date.getTime())) return new Date().toLocaleDateString("en-CA");
  return date.toLocaleDateString("en-CA");
}

function mergeSources(stateSources: AppState["sources"]) {
  const sourceMap = new Map(initialState.sources.map((source) => [source.id, source]));
  for (const source of stateSources) {
    sourceMap.set(source.id, source);
  }
  return Array.from(sourceMap.values());
}
