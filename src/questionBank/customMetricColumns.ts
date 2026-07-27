import type {
  CustomMetricDefinitionDto,
  CustomMetricSummary,
} from "./customMetrics";

export const CUSTOM_METRIC_ACHIEVED_MARK = "○";

export interface CustomMetricColumn {
  metricId: string;
  name: string;
  icon?: string;
  sortOrder: number;
  matchedProblemIds: ReadonlySet<string>;
  populationProblemIds: ReadonlySet<string>;
}

export interface CustomMetricProgress {
  matchedCount: number;
  populationCount: number;
  unmatchedCount: number;
  achievementRate: number | null;
}

export type CustomMetricFilterMode = "matched" | "unmatched";
export type CustomMetricFilterSelections = Record<string, CustomMetricFilterMode>;

export function buildCustomMetricColumns(
  definitions: CustomMetricDefinitionDto[],
  summaries: CustomMetricSummary[],
): CustomMetricColumn[] {
  const summariesById = new Map(summaries.map((summary) => [summary.metricId, summary]));
  return definitions
    .filter((definition) => definition.isVisible)
    .sort((left, right) => (
      left.sortOrder - right.sortOrder || left.metricId.localeCompare(right.metricId)
    ))
    .flatMap((definition) => {
      const summary = summariesById.get(definition.metricId);
      if (!summary) return [];
      return [{
        metricId: definition.metricId,
        name: definition.name,
        icon: definition.icon,
        sortOrder: definition.sortOrder,
        matchedProblemIds: new Set(summary.matchedProblemIds),
        populationProblemIds: new Set(summary.populationProblemIds),
      }];
    });
}

export type CustomMetricCellState = "outside_population" | "matched" | "unmatched";

export function getCustomMetricCellState(
  column: CustomMetricColumn,
  problemId: string,
): CustomMetricCellState {
  if (!column.populationProblemIds.has(problemId)) return "outside_population";
  if (column.matchedProblemIds.has(problemId)) return "matched";
  return "unmatched";
}

export function customMetricCellText(state: CustomMetricCellState): string {
  if (state === "outside_population") return "—";
  if (state === "matched") return CUSTOM_METRIC_ACHIEVED_MARK;
  return "";
}

export function getCustomMetricProgress(
  column: CustomMetricColumn,
  scopedProblemIds?: Iterable<string>,
): CustomMetricProgress {
  const scope = scopedProblemIds ? new Set(scopedProblemIds) : null;
  const matchedCount = scope
    ? countIntersection(column.matchedProblemIds, scope)
    : column.matchedProblemIds.size;
  const populationCount = scope
    ? countIntersection(column.populationProblemIds, scope)
    : column.populationProblemIds.size;
  return {
    matchedCount,
    populationCount,
    unmatchedCount: populationCount - matchedCount,
    achievementRate: populationCount === 0 ? null : matchedCount / populationCount,
  };
}

function countIntersection(
  problemIds: ReadonlySet<string>,
  scope: ReadonlySet<string>,
): number {
  let count = 0;
  for (const problemId of problemIds) {
    if (scope.has(problemId)) count += 1;
  }
  return count;
}

export function formatCustomMetricRate(rate: number | null): string {
  return rate === null ? "—" : `${Math.round(rate * 100)}%`;
}

export function formatCustomMetricProgress(
  progress: CustomMetricProgress,
): string {
  return progress.achievementRate === null
    ? "—"
    : `${progress.matchedCount} / ${progress.populationCount} (${formatCustomMetricRate(progress.achievementRate)})`;
}

export function customMetricTooltip(
  column: CustomMetricColumn,
  scopedProblemIds?: Iterable<string>,
  scopeLabel?: string,
): string {
  const progress = getCustomMetricProgress(column, scopedProblemIds);
  return [
    scopeLabel ? `${scopeLabel} / ${column.name}` : column.name,
    `Population: ${progress.populationCount}問`,
    `達成: ${progress.matchedCount}問`,
    `未達: ${progress.unmatchedCount}問`,
    `達成率: ${formatCustomMetricRate(progress.achievementRate)}`,
  ].join("\n");
}

export function matchesCustomMetricFilters(
  problemId: string,
  columns: CustomMetricColumn[],
  selections: CustomMetricFilterSelections,
): boolean {
  const columnsById = new Map(columns.map((column) => [column.metricId, column]));
  return Object.entries(selections).every(([metricId, mode]) => {
    const column = columnsById.get(metricId);
    if (!column) return false;
    if (mode === "matched") return column.matchedProblemIds.has(problemId);
    return column.populationProblemIds.has(problemId)
      && !column.matchedProblemIds.has(problemId);
  });
}
