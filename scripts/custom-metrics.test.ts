import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_CUSTOM_METRIC_TEMPLATES,
  DEFAULT_POPULATION_DEFINITION,
  parseMetricDefinition,
  parsePopulationDefinition,
  serializeMetricDefinition,
  serializePopulationDefinition,
  validateMetricDefinition,
  validatePopulationDefinition,
  type MetricDefinition,
} from "../src/questionBank/customMetrics";

const confidentCorrect: MetricDefinition = {
  version: 1,
  operator: "and",
  clauses: [{
    kind: "attempt_count",
    attemptScope: "all",
    where: {
      operator: "and",
      clauses: [
        { kind: "field", field: "result", operator: "eq", value: "correct" },
        { kind: "field", field: "confidence", operator: "eq", value: "high" },
      ],
    },
    count: { operator: "gte", value: 1 },
  }],
};

test("DSLをJSONへ保存し同じ型として読み戻す", () => {
  const json = serializeMetricDefinition(confidentCorrect);
  assert.deepEqual(parseMetricDefinition(json), confidentCorrect);
});

test("すべてのAttempt scopeを受理する", () => {
  for (const attemptScope of ["all", "latest", "except_latest"] as const) {
    validateMetricDefinition({
      ...confidentCorrect,
      clauses: [{ ...confidentCorrect.clauses[0], attemptScope }],
    });
  }
});

test("未知version、未知項目、ORを拒否する", () => {
  assert.throws(() => validateMetricDefinition({ ...confidentCorrect, version: 2 }));
  assert.throws(() => validateMetricDefinition({ ...confidentCorrect, sql: "select 1" }));
  assert.throws(() => validateMetricDefinition({ ...confidentCorrect, operator: "or" }));
});

test("fieldとoperatorと値の不正な組み合わせを拒否する", () => {
  const withPredicate = (predicate: unknown) => ({
    ...confidentCorrect,
    clauses: [{
      ...confidentCorrect.clauses[0],
      where: { operator: "and", clauses: [predicate] },
    }],
  });
  assert.throws(() => validateMetricDefinition(withPredicate(
    { kind: "field", field: "result", operator: "gte", value: "correct" },
  )));
  assert.throws(() => validateMetricDefinition(withPredicate(
    { kind: "field", field: "attempt_number", operator: "eq", value: 0 },
  )));
  assert.throws(() => validateMetricDefinition(withPredicate(
    { kind: "field", field: "answered_at", operator: "eq", value: "2026-07-26" },
  )));
  assert.throws(() => validateMetricDefinition(withPredicate(
    { kind: "field", field: "answered_at", operator: "is_null", value: null },
  )));
});

test("3つのデフォルトメトリクス定義を固定する", () => {
  assert.deepEqual(
    DEFAULT_CUSTOM_METRIC_TEMPLATES.map(({ name, icon, systemKey }) => ({ name, icon, systemKey })),
    [
      { name: "正解歴", icon: "○", systemKey: "ever_correct" },
      { name: "自信あり正解歴", icon: "◎", systemKey: "ever_confident_correct" },
      { name: "複数正解歴", icon: "★", systemKey: "multiple_correct" },
    ],
  );
  DEFAULT_CUSTOM_METRIC_TEMPLATES.forEach(({ definition }) => validateMetricDefinition(definition));
  assert.equal(DEFAULT_CUSTOM_METRIC_TEMPLATES[2].definition.clauses[0].count.value, 2);
});

test("Population DSLをJSONへ保存し同じ型として読み戻す", () => {
  const json = serializePopulationDefinition(DEFAULT_POPULATION_DEFINITION);
  assert.deepEqual(parsePopulationDefinition(json), DEFAULT_POPULATION_DEFINITION);
});

test("デフォルトPopulationは除外以外の問題を対象にする", () => {
  assert.deepEqual(DEFAULT_POPULATION_DEFINITION, {
    version: 1,
    operator: "and",
    clauses: [{ kind: "problem_scope", scope: "non_excluded" }],
  });
  validatePopulationDefinition(DEFAULT_POPULATION_DEFINITION);
});

test("Population DSLの未知version、OR、未知scope、未知項目を拒否する", () => {
  assert.throws(() => validatePopulationDefinition({ ...DEFAULT_POPULATION_DEFINITION, version: 2 }));
  assert.throws(() => validatePopulationDefinition({ ...DEFAULT_POPULATION_DEFINITION, operator: "or" }));
  assert.throws(() => validatePopulationDefinition({
    ...DEFAULT_POPULATION_DEFINITION,
    clauses: [{ kind: "problem_scope", scope: "all" }],
  }));
  assert.throws(() => validatePopulationDefinition({ ...DEFAULT_POPULATION_DEFINITION, sql: "select 1" }));
});
