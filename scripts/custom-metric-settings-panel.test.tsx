import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  changeCustomMetricVisibility,
  CustomMetricDeleteDialog,
  CustomMetricResetDialog,
  CustomMetricSettingsContent,
  deleteCustomMetricAndReload,
  loadCustomMetricSettings,
  moveCustomMetricSetting,
  resetCustomMetricsAndReload,
  restoreCustomMetricDefault,
  type CustomMetricSettingsRepository,
} from "../src/questionBank/CustomMetricSettingsPanel";
import {
  DEFAULT_CUSTOM_METRIC_TEMPLATES,
  DEFAULT_POPULATION_DEFINITION,
  type CustomMetricDefinitionDto,
} from "../src/questionBank/customMetrics";

function metric(
  metricId: string,
  sortOrder: number,
  overrides: Partial<CustomMetricDefinitionDto> = {},
): CustomMetricDefinitionDto {
  return {
    metricId,
    name: `メトリクス${metricId}`,
    icon: "○",
    definition: DEFAULT_CUSTOM_METRIC_TEMPLATES[0].definition,
    population: DEFAULT_POPULATION_DEFINITION,
    isVisible: true,
    sortOrder,
    origin: "custom",
    systemKey: null,
    ...overrides,
  };
}

function repository(
  overrides: Partial<CustomMetricSettingsRepository> = {},
): CustomMetricSettingsRepository {
  return {
    listCustomMetrics: async () => [],
    createCustomMetric: async () => metric("created", 0),
    updateCustomMetric: async () => metric("metric-1", 0),
    setCustomMetricVisibility: async (_metricId, isVisible) => (
      metric("metric-1", 0, { isVisible })
    ),
    moveCustomMetric: async () => [],
    deleteCustomMetric: async () => undefined,
    resetCustomMetrics: async () => [],
    restoreDefaultCustomMetric: async () => "restored",
    ...overrides,
  };
}

const noop = () => undefined;
const baseState = {
  metrics: [] as CustomMetricDefinitionDto[],
  loading: false,
  error: "",
  moving: null,
  deleting: null,
  restoring: null,
  resetting: false,
  onReload: noop,
  onVisibilityChange: noop,
  onMove: noop,
  onDelete: noop,
  onRestore: noop,
  onCreate: noop,
  onEdit: noop,
  onReset: noop,
};

test("一覧取得結果をsortOrder順へ整列してReact一覧へ表示する", async () => {
  const metrics = await loadCustomMetricSettings(repository({
    listCustomMetrics: async () => [
      metric("second", 1),
      metric("first", 0, { name: "正解歴", origin: "default", systemKey: "ever_correct" }),
    ],
  }), "bank-1");

  assert.deepEqual(metrics.map((item) => item.metricId), ["first", "second"]);
  const html = renderToStaticMarkup(
    <CustomMetricSettingsContent {...baseState} metrics={metrics} />,
  );
  assert.match(html, /正解歴/);
  assert.match(html, /Default/);
  assert.match(html, /Custom/);
  assert.ok(html.indexOf("正解歴") < html.indexOf("メトリクスsecond"));
});

test("Empty・Error・Skeleton状態を表示する", () => {
  const empty = renderToStaticMarkup(
    <CustomMetricSettingsContent {...baseState} />,
  );
  assert.match(empty, /メトリクスがありません/);

  const error = renderToStaticMarkup(
    <CustomMetricSettingsContent {...baseState} error="取得に失敗しました" />,
  );
  assert.match(error, /role="alert"/);
  assert.match(error, /取得に失敗しました/);
  assert.match(error, /再読み込み/);

  const loading = renderToStaticMarkup(
    <CustomMetricSettingsContent {...baseState} loading />,
  );
  assert.match(loading, /カスタムメトリクスを読み込んでいます/);
});

test("Toggleは対象IDと表示状態をRepositoryへ渡す", async () => {
  const calls: unknown[][] = [];
  const source = metric("toggle", 0);
  const updated = await changeCustomMetricVisibility(repository({
    setCustomMetricVisibility: async (metricId, isVisible) => {
      calls.push([metricId, isVisible]);
      return { ...source, isVisible };
    },
  }), source, false);

  assert.deepEqual(calls, [["toggle", false]]);
  assert.equal(updated.isVisible, false);
});

test("MoveはnewSortOrderを渡し、応答を再整列する", async () => {
  const calls: unknown[][] = [];
  const source = metric("moving", 1);
  const moved = await moveCustomMetricSetting(repository({
    moveCustomMetric: async (metricId, newSortOrder) => {
      calls.push([metricId, newSortOrder]);
      return [metric("other", 1), { ...source, sortOrder: 0 }];
    },
  }), source, 0);

  assert.deepEqual(calls, [["moving", 0]]);
  assert.deepEqual(moved.map((item) => item.metricId), ["moving", "other"]);
});

test("Restore後に同じQuestion Bankの一覧を再取得する", async () => {
  const calls: string[] = [];
  const restored = metric("restored", 0, {
    name: "正解歴",
    origin: "default",
    systemKey: "ever_correct",
  });
  const result = await restoreCustomMetricDefault(repository({
    restoreDefaultCustomMetric: async (questionBankId, systemKey) => {
      calls.push(`restore:${questionBankId}:${systemKey}`);
      return "restored";
    },
    listCustomMetrics: async (questionBankId) => {
      calls.push(`list:${questionBankId}`);
      return [restored];
    },
  }), "bank-1", "ever_correct");

  assert.deepEqual(calls, [
    "restore:bank-1:ever_correct",
    "list:bank-1",
  ]);
  assert.deepEqual(result, [restored]);
});

test("一覧とEditorで共用する削除確認ダイアログを表示する", () => {
  const target = metric("delete-target", 0, {
    name: "削除対象",
    origin: "default",
    systemKey: "ever_correct",
  });
  const html = renderToStaticMarkup(
    <CustomMetricDeleteDialog
      metric={target}
      deleting={false}
      onCancel={() => undefined}
      onConfirm={async () => undefined}
    />,
  );
  assert.match(html, /メトリクスを削除しますか/);
  assert.match(html, /削除対象/);
  assert.match(html, /削除する/);
  assert.match(html, /利用していないデフォルトメトリクス/);
});

test("削除確定はRepository削除後に一覧を再取得する", async () => {
  const calls: string[] = [];
  const remaining = metric("remaining", 0);
  const result = await deleteCustomMetricAndReload(repository({
    deleteCustomMetric: async (metricId) => {
      calls.push(`delete:${metricId}`);
    },
    listCustomMetrics: async (questionBankId) => {
      calls.push(`list:${questionBankId}`);
      return [remaining];
    },
  }), "bank-1", "delete-target");
  assert.deepEqual(calls, ["delete:delete-target", "list:bank-1"]);
  assert.deepEqual(result, [remaining]);
});

test("削除失敗時は一覧再取得へ進まずエラーを伝播する", async () => {
  const calls: string[] = [];
  await assert.rejects(
    deleteCustomMetricAndReload(repository({
      deleteCustomMetric: async (metricId) => {
        calls.push(`delete:${metricId}`);
        throw new Error("削除失敗");
      },
      listCustomMetrics: async () => {
        calls.push("list");
        return [];
      },
    }), "bank-1", "delete-target"),
    /削除失敗/,
  );
  assert.deepEqual(calls, ["delete:delete-target"]);
});

test("デフォルト削除後は復元候補へ移り、Custom削除後は一覧から消える", () => {
  const activeCustom = metric("custom-active", 0);
  const html = renderToStaticMarkup(
    <CustomMetricSettingsContent
      {...baseState}
      metrics={[activeCustom]}
    />,
  );
  assert.match(html, /メトリクスcustom-active/);
  assert.match(html, /利用していないデフォルトメトリクス/);
  assert.match(html, /正解歴/);
  assert.doesNotMatch(html, /delete-target/);
});

test("全体リセット確認ダイアログに不可逆な変更内容を表示する", () => {
  const html = renderToStaticMarkup(
    <CustomMetricResetDialog
      resetting={false}
      onCancel={() => undefined}
      onConfirm={async () => undefined}
    />,
  );
  assert.match(html, /カスタムメトリクスを初期状態に戻しますか/);
  assert.match(html, /デフォルトメトリクスは初期状態へ戻ります/);
  assert.match(html, /削除したデフォルトメトリクスは復元されます/);
  assert.match(html, /作成したカスタムメトリクスはすべて削除されます/);
  assert.match(html, /この操作は元に戻せません/);
});

test("全体リセット成功後に一覧を再取得する", async () => {
  const calls: string[] = [];
  const defaults = [metric("default", 0, {
    origin: "default",
    systemKey: "ever_correct",
  })];
  const result = await resetCustomMetricsAndReload(repository({
    resetCustomMetrics: async (questionBankId) => {
      calls.push(`reset:${questionBankId}`);
      return defaults;
    },
    listCustomMetrics: async (questionBankId) => {
      calls.push(`list:${questionBankId}`);
      return defaults;
    },
  }), "bank-1");
  assert.deepEqual(calls, ["reset:bank-1", "list:bank-1"]);
  assert.deepEqual(result, defaults);
});

test("全体リセット失敗時は一覧再取得へ進まずエラーを伝播する", async () => {
  const calls: string[] = [];
  await assert.rejects(
    resetCustomMetricsAndReload(repository({
      resetCustomMetrics: async () => {
        calls.push("reset");
        throw new Error("Backend失敗");
      },
      listCustomMetrics: async () => {
        calls.push("list");
        return [];
      },
    }), "bank-1"),
    /Backend失敗/,
  );
  assert.deepEqual(calls, ["reset"]);
});
