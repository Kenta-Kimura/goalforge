import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  ConditionSummaryPreview,
  CustomMetricEditor,
  requestDiscardCustomMetricChanges,
  saveCustomMetricDraft,
} from "../src/questionBank/CustomMetricEditor";
import {
  createCustomMetricDraft,
  customMetricDraftEquals,
  summarizeCustomMetricDraft,
  validateCustomMetricDraft,
} from "../src/questionBank/customMetricEditorModel";
import {
  DEFAULT_CUSTOM_METRIC_TEMPLATES,
  DEFAULT_POPULATION_DEFINITION,
  type CustomMetricDefinitionDto,
} from "../src/questionBank/customMetrics";
import type { CustomMetricSettingsRepository } from "../src/questionBank/CustomMetricSettingsPanel";

function existingMetric(): CustomMetricDefinitionDto {
  return {
    metricId: "metric-1",
    name: "正解歴",
    icon: "○",
    definition: DEFAULT_CUSTOM_METRIC_TEMPLATES[0].definition,
    population: DEFAULT_POPULATION_DEFINITION,
    isVisible: true,
    sortOrder: 0,
    origin: "default",
    systemKey: "ever_correct",
  };
}

function repository(
  overrides: Partial<CustomMetricSettingsRepository> = {},
): CustomMetricSettingsRepository {
  const saved = existingMetric();
  return {
    listCustomMetrics: async () => [saved],
    createCustomMetric: async (_questionBankId, input) => ({
      ...saved,
      metricId: "created",
      origin: "custom",
      systemKey: null,
      ...input,
    }),
    updateCustomMetric: async (_metricId, input) => ({ ...saved, ...input }),
    setCustomMetricVisibility: async () => saved,
    moveCustomMetric: async () => [saved],
    deleteCustomMetric: async () => undefined,
    resetCustomMetrics: async () => [],
    restoreDefaultCustomMetric: async () => "restored",
    ...overrides,
  };
}

test("新規Editorは共通DraftとreadOnly Populationを表示する", () => {
  const draft = createCustomMetricDraft();
  const html = renderToStaticMarkup(
    <CustomMetricEditor draft={draft} onChange={() => undefined} />,
  );
  assert.equal(draft.name, "");
  assert.equal(draft.definition.clauses[0].attemptScope, "all");
  assert.match(html, /基本設定/);
  assert.match(html, /すべてANDで判定/);
  assert.match(html, /除外状態ではない、この教材の全問題/);
});

test("編集EditorはDTOを複製したDraftから開始する", () => {
  const source = existingMetric();
  const draft = createCustomMetricDraft(source);
  draft.definition.clauses[0].count.value = 2;
  assert.equal(source.definition.clauses[0].count.value, 1);
  assert.equal(draft.name, source.name);
});

test("Dirty判定はJSON文字列ではなくASTを再帰比較する", () => {
  const initial = createCustomMetricDraft(existingMetric());
  const same = createCustomMetricDraft(existingMetric());
  const changed = createCustomMetricDraft(existingMetric());
  changed.definition.clauses[0].where.clauses.push({
    kind: "field",
    field: "confidence",
    operator: "eq",
    value: "high",
  });
  assert.equal(customMetricDraftEquals(initial, same), true);
  assert.equal(customMetricDraftEquals(initial, changed), false);
});

test("名前と既存DSL Validationをリアルタイム検証へ利用する", () => {
  const invalid = createCustomMetricDraft();
  invalid.definition.operator = "or";
  const validation = validateCustomMetricDraft(invalid);
  assert.equal(validation.valid, false);
  assert.ok(validation.errors.some((error) => error.includes("名前")));
  assert.ok(validation.errors.some((error) => error.includes("andのみ")));
});

test("Condition SummaryはAttempt Scope・Predicate・Count変更を反映する", () => {
  const draft = createCustomMetricDraft();
  draft.definition.clauses[0].attemptScope = "latest";
  draft.definition.clauses[0].where.clauses.push({
    kind: "field",
    field: "confidence",
    operator: "eq",
    value: "high",
  });
  draft.definition.clauses[0].count.value = 2;
  const summary = summarizeCustomMetricDraft(draft);
  const html = renderToStaticMarkup(<ConditionSummaryPreview draft={draft} />);
  assert.match(summary, /最新Attempt/);
  assert.match(summary, /正解/);
  assert.match(summary, /確信度高/);
  assert.match(summary, /2回以上/);
  assert.match(html, /2回以上/);
});

test("保存は新規と編集でCreate・Updateを使い分ける", async () => {
  const calls: string[] = [];
  const mock = repository({
    createCustomMetric: async (bankId, input) => {
      calls.push(`create:${bankId}:${input.name}`);
      return { ...existingMetric(), metricId: "created", name: input.name };
    },
    updateCustomMetric: async (metricId, input) => {
      calls.push(`update:${metricId}:${input.name}`);
      return { ...existingMetric(), name: input.name };
    },
  });
  const draft = createCustomMetricDraft();
  draft.name = "初見正解";
  await saveCustomMetricDraft(mock, "bank-1", null, draft);
  await saveCustomMetricDraft(mock, "bank-1", existingMetric(), draft);
  assert.deepEqual(calls, [
    "create:bank-1:初見正解",
    "update:metric-1:初見正解",
  ]);
});

test("保存失敗は呼び出し元Draftを変更せずrejectする", async () => {
  const draft = createCustomMetricDraft();
  draft.name = "失敗確認";
  const before = createCustomMetricDraft();
  before.name = "失敗確認";
  await assert.rejects(
    saveCustomMetricDraft(repository({
      createCustomMetric: async () => {
        throw new Error("保存失敗");
      },
    }), "bank-1", null, draft),
    /保存失敗/,
  );
  assert.equal(customMetricDraftEquals(draft, before), true);
});

test("未保存警告はDirty時だけ確認結果を要求する", () => {
  let confirmations = 0;
  assert.equal(requestDiscardCustomMetricChanges(false, () => {
    confirmations += 1;
    return false;
  }), true);
  assert.equal(confirmations, 0);
  assert.equal(requestDiscardCustomMetricChanges(true, () => {
    confirmations += 1;
    return false;
  }), false);
  assert.equal(requestDiscardCustomMetricChanges(true, () => {
    confirmations += 1;
    return true;
  }), true);
  assert.equal(confirmations, 2);
});
