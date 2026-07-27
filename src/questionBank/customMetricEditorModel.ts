import {
  CUSTOM_METRIC_DEFINITION_VERSION,
  DEFAULT_POPULATION_DEFINITION,
  type AttemptField,
  type AttemptPredicate,
  type AttemptPredicateValue,
  type ComparisonOperator,
  type CountOperator,
  type CustomMetricDefinitionDto,
  type CustomMetricWriteInput,
  type MetricDefinition,
  type PopulationDefinition,
  validateMetricDefinition,
  validatePopulationDefinition,
} from "./customMetrics";

export interface CustomMetricDraft {
  name: string;
  icon: string;
  isVisible: boolean;
  definition: MetricDefinition;
  population: PopulationDefinition;
}

export interface CustomMetricDraftValidation {
  valid: boolean;
  errors: string[];
}

export function createCustomMetricDraft(
  metric?: CustomMetricDefinitionDto,
): CustomMetricDraft {
  if (metric) {
    return {
      name: metric.name,
      icon: metric.icon ?? "",
      isVisible: metric.isVisible,
      definition: cloneDefinition(metric.definition),
      population: clonePopulation(metric.population),
    };
  }
  return {
    name: "",
    icon: "",
    isVisible: true,
    definition: {
      version: CUSTOM_METRIC_DEFINITION_VERSION,
      operator: "and",
      clauses: [{
        kind: "attempt_count",
        attemptScope: "all",
        where: {
          operator: "and",
          clauses: [{ kind: "field", field: "result", operator: "eq", value: "correct" }],
        },
        count: { operator: "gte", value: 1 },
      }],
    },
    population: clonePopulation(DEFAULT_POPULATION_DEFINITION),
  };
}

export function customMetricDraftToWriteInput(
  draft: CustomMetricDraft,
): CustomMetricWriteInput {
  return {
    name: draft.name.trim(),
    icon: draft.icon.trim() || undefined,
    isVisible: draft.isVisible,
    definition: cloneDefinition(draft.definition),
    population: clonePopulation(draft.population),
  };
}

export function validateCustomMetricDraft(
  draft: CustomMetricDraft,
): CustomMetricDraftValidation {
  const errors: string[] = [];
  if (!draft.name.trim()) errors.push("名前を入力してください。");
  try {
    validateMetricDefinition(draft.definition);
  } catch (reason) {
    errors.push(reason instanceof Error ? reason.message : String(reason));
  }
  try {
    validatePopulationDefinition(draft.population);
  } catch (reason) {
    errors.push(reason instanceof Error ? reason.message : String(reason));
  }
  return { valid: errors.length === 0, errors };
}

export function customMetricDraftEquals(
  left: CustomMetricDraft,
  right: CustomMetricDraft,
): boolean {
  return astEquals(left, right);
}

function astEquals(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left)
      && Array.isArray(right)
      && left.length === right.length
      && left.every((value, index) => astEquals(value, right[index]));
  }
  if (typeof left !== "object" || left === null || typeof right !== "object" || right === null) {
    return false;
  }
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord);
  const rightKeys = Object.keys(rightRecord);
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key) => Object.hasOwn(rightRecord, key)
      && astEquals(leftRecord[key], rightRecord[key]));
}

export function summarizeCustomMetricDraft(draft: CustomMetricDraft): string {
  const clause = draft.definition.clauses[0];
  const scope = {
    all: "全Attempt",
    latest: "最新Attempt",
    except_latest: "最新以外のAttempt",
  }[clause.attemptScope];
  const predicates = clause.where.clauses.length === 0
    ? "条件なし"
    : clause.where.clauses.map(summarizePredicate).join("かつ");
  const count = summarizeCount(clause.count.operator, clause.count.value);
  return `${scope}のうち、${predicates}が${count}問題`;
}

function summarizePredicate(predicate: AttemptPredicate): string {
  const field = {
    result: "解答",
    confidence: "確信度",
    attempt_number: "解答回数",
    round_id: "周回ID",
    round_number: "周回番号",
    answered_at: "解答日時",
  }[predicate.field];
  const operator = {
    eq: "＝",
    neq: "≠",
    gte: "以上",
    lte: "以下",
    between: "の範囲",
    is_null: "なし",
    is_not_null: "あり",
  }[predicate.operator];
  return `${field}${formatPredicateValue(predicate.value)}${operator}`;
}

function formatPredicateValue(value: AttemptPredicateValue | undefined): string {
  if (value === undefined) return "";
  const labels: Record<string, string> = {
    correct: "正解",
    partial: "部分正解",
    incorrect: "不正解",
    high: "高",
    medium: "中",
    low: "低",
  };
  if (Array.isArray(value)) return `${value[0]}〜${value[1]}`;
  return labels[String(value)] ?? String(value);
}

function summarizeCount(operator: CountOperator, value: number): string {
  if (operator === "gte") return `${value}回以上ある`;
  if (operator === "lte") return `${value}回以下である`;
  return `${value}回ある`;
}

export function defaultPredicateForField(field: AttemptField): AttemptPredicate {
  if (field === "result") return { kind: "field", field, operator: "eq", value: "correct" };
  if (field === "confidence") return { kind: "field", field, operator: "eq", value: "high" };
  if (field === "round_id") return { kind: "field", field, operator: "eq", value: "round-1" };
  if (field === "answered_at") {
    return { kind: "field", field, operator: "gte", value: new Date().toISOString() };
  }
  return { kind: "field", field, operator: "gte", value: 1 };
}

export function operatorsForField(field: AttemptField): ComparisonOperator[] {
  if (field === "result" || field === "confidence" || field === "round_id") {
    return ["eq", "neq", "is_null", "is_not_null"];
  }
  return ["eq", "neq", "gte", "lte", "between", "is_null", "is_not_null"];
}

export function predicateWithOperator(
  predicate: AttemptPredicate,
  operator: ComparisonOperator,
): AttemptPredicate {
  if (operator === "is_null" || operator === "is_not_null") {
    return { kind: "field", field: predicate.field, operator };
  }
  const fallback = defaultPredicateForField(predicate.field);
  let value = predicate.value ?? fallback.value;
  if (operator === "between" && !Array.isArray(value)) {
    value = predicate.field === "answered_at"
      ? [String(value), String(value)] as readonly [string, string]
      : [Number(value), Number(value)] as readonly [number, number];
  }
  if (operator !== "between" && Array.isArray(value)) value = value[0];
  return { kind: "field", field: predicate.field, operator, value };
}

function cloneDefinition(definition: MetricDefinition): MetricDefinition {
  return {
    ...definition,
    clauses: definition.clauses.map((clause) => ({
      ...clause,
      where: {
        ...clause.where,
        clauses: clause.where.clauses.map((predicate) => {
          const value = Array.isArray(predicate.value)
            ? (
              typeof predicate.value[0] === "number"
                ? [predicate.value[0], predicate.value[1]] as readonly [number, number]
                : [predicate.value[0], predicate.value[1]] as readonly [string, string]
            )
            : predicate.value;
          return { ...predicate, value };
        }),
      },
      count: { ...clause.count },
    })),
  };
}

function clonePopulation(population: PopulationDefinition): PopulationDefinition {
  return {
    ...population,
    clauses: population.clauses.map((clause) => ({ ...clause })),
  };
}
