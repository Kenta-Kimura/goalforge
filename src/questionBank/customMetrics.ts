export const DSL_VERSION = 1 as const;
export const CUSTOM_METRIC_DEFINITION_VERSION = DSL_VERSION;
export const POPULATION_DEFINITION_VERSION = DSL_VERSION;

export type MetricOrigin = "default" | "custom";
export type BooleanOperator = "and" | "or";
export type AttemptScope = "all" | "latest" | "except_latest";
export type AttemptField =
  | "result"
  | "confidence"
  | "attempt_number"
  | "round_id"
  | "round_number"
  | "answered_at";
export type ComparisonOperator = "eq" | "neq" | "gte" | "lte" | "between" | "is_null" | "is_not_null";
export type CountOperator = "eq" | "gte" | "lte";
export type AttemptResultValue = "correct" | "partial" | "incorrect";
export type AttemptConfidenceValue = "high" | "medium" | "low";
export type AttemptPredicateValue =
  | AttemptResultValue
  | AttemptConfidenceValue
  | number
  | string
  | readonly [number, number]
  | readonly [string, string];

export interface CustomMetricSummary {
  metricId: string;
  metricName: string;
  icon?: string;
  matchedProblemIds: string[];
  populationProblemIds: string[];
}

export type RestoreDefaultMetricOutcome = "unchanged" | "restored" | "inserted";

export interface CustomMetricDefinitionDto {
  metricId: string;
  name: string;
  icon?: string;
  definition: MetricDefinition;
  population: PopulationDefinition;
  isVisible: boolean;
  sortOrder: number;
  origin: MetricOrigin;
  systemKey: string | null;
}

export interface CustomMetricWriteInput {
  name: string;
  icon?: string;
  definition: MetricDefinition;
  population: PopulationDefinition;
  isVisible: boolean;
}

export interface CustomMetricManagementError {
  kind: "validation" | "repository" | "service";
  message: string;
}

export interface CustomMetric {
  id: string;
  questionBankId: string;
  name: string;
  icon: string | null;
  definitionVersion: number;
  definition: MetricDefinition;
  population: PopulationDefinition;
  isVisible: boolean;
  sortOrder: number;
  origin: MetricOrigin;
  systemKey: string | null;
}

export interface DslDefinition<Clause> {
  version: number;
  operator: BooleanOperator;
  clauses: Clause[];
}

export type MetricDefinition = DslDefinition<MetricClause>;
export type PopulationDefinition = DslDefinition<PopulationClause>;

export interface AttemptCountClause {
  kind: "attempt_count";
  attemptScope: AttemptScope;
  where: AttemptFilterGroup;
  count: CountComparison;
}

export type MetricClause = AttemptCountClause;

export interface ProblemScopeClause {
  kind: "problem_scope";
  scope: ProblemScope;
}

export type PopulationClause = ProblemScopeClause;
export type ProblemScope = "non_excluded";

export interface AttemptFilterGroup {
  operator: BooleanOperator;
  clauses: AttemptPredicate[];
}

export interface AttemptPredicate {
  kind: "field";
  field: AttemptField;
  operator: ComparisonOperator;
  value?: AttemptPredicateValue;
}

export interface CountComparison {
  operator: CountOperator;
  value: number;
}

export interface DefaultMetricTemplate {
  name: string;
  icon: string;
  systemKey: "ever_correct" | "ever_confident_correct" | "multiple_correct";
  definition: MetricDefinition;
}

export const DEFAULT_CUSTOM_METRIC_TEMPLATES: readonly DefaultMetricTemplate[] = [
  {
    name: "正解歴",
    icon: "○",
    systemKey: "ever_correct",
    definition: attemptCountDefinition(
      [{ kind: "field", field: "result", operator: "eq", value: "correct" }],
      1,
    ),
  },
  {
    name: "自信あり正解歴",
    icon: "◎",
    systemKey: "ever_confident_correct",
    definition: attemptCountDefinition(
      [
        { kind: "field", field: "result", operator: "eq", value: "correct" },
        { kind: "field", field: "confidence", operator: "eq", value: "high" },
      ],
      1,
    ),
  },
  {
    name: "複数正解歴",
    icon: "★",
    systemKey: "multiple_correct",
    definition: attemptCountDefinition(
      [{ kind: "field", field: "result", operator: "eq", value: "correct" }],
      2,
    ),
  },
] as const;

export const DEFAULT_POPULATION_DEFINITION: PopulationDefinition = {
  version: POPULATION_DEFINITION_VERSION,
  operator: "and",
  clauses: [{ kind: "problem_scope", scope: "non_excluded" }],
};

export class MetricDefinitionValidationError extends Error {}
export class PopulationDefinitionValidationError extends Error {}

export function parseMetricDefinition(json: string): MetricDefinition {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch (error) {
    throw new MetricDefinitionValidationError(`カスタムメトリクス定義のJSONが不正です: ${String(error)}`);
  }
  validateMetricDefinition(value);
  return value;
}

export function serializeMetricDefinition(definition: MetricDefinition): string {
  validateMetricDefinition(definition);
  return JSON.stringify(definition);
}

export function parsePopulationDefinition(json: string): PopulationDefinition {
  return parseJson(json, "Population", validatePopulationDefinition);
}

export function serializePopulationDefinition(definition: PopulationDefinition): string {
  validatePopulationDefinition(definition);
  return JSON.stringify(definition);
}

export function validatePopulationDefinition(value: unknown): asserts value is PopulationDefinition {
  const definition = strictObject(value, ["version", "operator", "clauses"], "population");
  if (definition.version !== POPULATION_DEFINITION_VERSION) {
    throw new PopulationDefinitionValidationError(
      `未対応のPopulation definition versionです: ${String(definition.version)}`,
    );
  }
  validatePopulationAndOperator(definition.operator);
  if (!Array.isArray(definition.clauses) || definition.clauses.length === 0) {
    throw new PopulationDefinitionValidationError("Population条件を1件以上指定してください");
  }
  definition.clauses.forEach((value) => {
    const clause = strictObject(value, ["kind", "scope"], "population clause");
    if (clause.kind !== "problem_scope") {
      throw new PopulationDefinitionValidationError(`未知のPopulation clauseです: ${String(clause.kind)}`);
    }
    if (clause.scope !== "non_excluded") {
      throw new PopulationDefinitionValidationError(`未知のproblem scopeです: ${String(clause.scope)}`);
    }
  });
}

export function validateMetricDefinition(value: unknown): asserts value is MetricDefinition {
  const definition = strictObject(value, ["version", "operator", "clauses"], "definition");
  if (definition.version !== CUSTOM_METRIC_DEFINITION_VERSION) {
    throw new MetricDefinitionValidationError(`未対応のdefinition versionです: ${String(definition.version)}`);
  }
  validateAndOperator(definition.operator);
  if (!Array.isArray(definition.clauses) || definition.clauses.length === 0) {
    throw new MetricDefinitionValidationError("メトリクス条件を1件以上指定してください");
  }
  definition.clauses.forEach(validateMetricClause);
}

function validateMetricClause(value: unknown): void {
  const clause = strictObject(value, ["kind", "attemptScope", "where", "count"], "metric clause");
  if (clause.kind !== "attempt_count") {
    throw new MetricDefinitionValidationError(`未知のmetric clauseです: ${String(clause.kind)}`);
  }
  if (!["all", "latest", "except_latest"].includes(String(clause.attemptScope))) {
    throw new MetricDefinitionValidationError(`未知のattempt_scopeです: ${String(clause.attemptScope)}`);
  }

  const where = strictObject(clause.where, ["operator", "clauses"], "where");
  validateAndOperator(where.operator);
  if (!Array.isArray(where.clauses)) {
    throw new MetricDefinitionValidationError("where.clausesは配列で指定してください");
  }
  where.clauses.forEach(validateAttemptPredicate);

  const count = strictObject(clause.count, ["operator", "value"], "count");
  if (!["eq", "gte", "lte"].includes(String(count.operator))) {
    throw new MetricDefinitionValidationError(`未知のcount operatorです: ${String(count.operator)}`);
  }
  if (!isNonNegativeInteger(count.value)) {
    throw new MetricDefinitionValidationError("count.valueは0以上の整数で指定してください");
  }
}

function validateAttemptPredicate(value: unknown): void {
  const predicate = strictObject(value, ["kind", "field", "operator", "value"], "attempt predicate", ["value"]);
  if (predicate.kind !== "field") {
    throw new MetricDefinitionValidationError(`未知のattempt predicateです: ${String(predicate.kind)}`);
  }
  if (!isAttemptField(predicate.field)) {
    throw new MetricDefinitionValidationError(`未知のattempt fieldです: ${String(predicate.field)}`);
  }
  if (!isComparisonOperator(predicate.operator)) {
    throw new MetricDefinitionValidationError(`未知のcomparison operatorです: ${String(predicate.operator)}`);
  }

  const { field, operator } = predicate as { field: AttemptField; operator: ComparisonOperator };
  const hasValue = Object.hasOwn(predicate, "value");
  if (operator === "is_null" || operator === "is_not_null") {
    if (hasValue) {
      throw new MetricDefinitionValidationError(`${operator}にはvalueを指定できません`);
    }
    return;
  }
  if (!hasValue) {
    throw new MetricDefinitionValidationError(`${field}のvalueを指定してください`);
  }
  if (!operatorSupportedForField(field, operator)) {
    throw new MetricDefinitionValidationError(`${field}では${operator}を使用できません`);
  }
  if (!validFieldValue(field, operator, predicate.value)) {
    throw new MetricDefinitionValidationError(`${field}の値が不正です`);
  }
}

function validateAndOperator(value: unknown): void {
  if (value !== "and") {
    if (value === "or") {
      throw new MetricDefinitionValidationError("version 1ではoperatorはandのみ使用できます");
    }
    throw new MetricDefinitionValidationError(`未知のboolean operatorです: ${String(value)}`);
  }
}

function validatePopulationAndOperator(value: unknown): void {
  if (value !== "and") {
    if (value === "or") {
      throw new PopulationDefinitionValidationError("Population version 1ではoperatorはandのみ使用できます");
    }
    throw new PopulationDefinitionValidationError(`未知のboolean operatorです: ${String(value)}`);
  }
}

function operatorSupportedForField(field: AttemptField, operator: ComparisonOperator): boolean {
  if (operator === "is_null" || operator === "is_not_null") return true;
  if (field === "result" || field === "confidence" || field === "round_id") {
    return operator === "eq" || operator === "neq";
  }
  return ["eq", "neq", "gte", "lte", "between"].includes(operator);
}

function validFieldValue(field: AttemptField, operator: ComparisonOperator, value: unknown): boolean {
  if (field === "result") return ["correct", "partial", "incorrect"].includes(String(value));
  if (field === "confidence") return ["high", "medium", "low"].includes(String(value));
  if (field === "round_id") return typeof value === "string" && value.trim().length > 0;
  const validateItem = field === "answered_at" ? isRfc3339 : isPositiveInteger;
  if (operator === "between") {
    if (!Array.isArray(value) || value.length !== 2 || !value.every(validateItem)) return false;
    return field === "answered_at"
      ? Date.parse(value[0] as string) <= Date.parse(value[1] as string)
      : (value[0] as number) <= (value[1] as number);
  }
  return validateItem(value);
}

function attemptCountDefinition(clauses: AttemptPredicate[], minimumCount: number): MetricDefinition {
  return {
    version: CUSTOM_METRIC_DEFINITION_VERSION,
    operator: "and",
    clauses: [{
      kind: "attempt_count",
      attemptScope: "all",
      where: { operator: "and", clauses },
      count: { operator: "gte", value: minimumCount },
    }],
  };
}

function parseJson<T>(
  json: string,
  label: string,
  validate: (value: unknown) => asserts value is T,
): T {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch (error) {
    throw new PopulationDefinitionValidationError(`${label}定義のJSONが不正です: ${String(error)}`);
  }
  validate(value);
  return value;
}

function strictObject(
  value: unknown,
  allowed: string[],
  label: string,
  optional: string[] = [],
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new MetricDefinitionValidationError(`${label}はオブジェクトで指定してください`);
  }
  const object = value as Record<string, unknown>;
  const unknown = Object.keys(object).find((key) => !allowed.includes(key));
  if (unknown) throw new MetricDefinitionValidationError(`${label}に未知の項目があります: ${unknown}`);
  const missing = allowed.find((key) => !optional.includes(key) && !Object.hasOwn(object, key));
  if (missing) throw new MetricDefinitionValidationError(`${label}.${missing}が必要です`);
  return object;
}

function isAttemptField(value: unknown): value is AttemptField {
  return ["result", "confidence", "attempt_number", "round_id", "round_number", "answered_at"].includes(String(value));
}

function isComparisonOperator(value: unknown): value is ComparisonOperator {
  return ["eq", "neq", "gte", "lte", "between", "is_null", "is_not_null"].includes(String(value));
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1;
}

function isRfc3339(value: unknown): value is string {
  return typeof value === "string"
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
    && !Number.isNaN(Date.parse(value));
}
