import assert from "node:assert/strict";
import test from "node:test";
import { SqliteQuestionBankRepository } from "../src/questionBank/repository";
import type {
  CustomMetricDefinitionDto,
  CustomMetricManagementError,
  CustomMetricSummary,
  CustomMetricWriteInput,
  RestoreDefaultMetricOutcome,
} from "../src/questionBank/customMetrics";
import {
  DEFAULT_CUSTOM_METRIC_TEMPLATES,
  DEFAULT_POPULATION_DEFINITION,
} from "../src/questionBank/customMetrics";

test("repositoryが集計CommandへcamelCase引数を渡しDTO配列を返す", async () => {
  const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
  const response: CustomMetricSummary[] = [{
    metricId: "metric-1",
    metricName: "正解歴",
    icon: "○",
    matchedProblemIds: ["p1"],
    populationProblemIds: ["p1", "p2"],
  }];
  const repository = new SqliteQuestionBankRepository(async <T>(
    command: string,
    args?: Record<string, unknown>,
  ) => {
    calls.push({ command, args });
    return response as unknown as T;
  });

  const result = await repository.getCustomMetricSummaries("bank-1");
  assert.deepEqual(result, response);
  assert.deepEqual(calls, [{
    command: "get_custom_metric_summaries",
    args: { questionBankId: "bank-1" },
  }]);
  assert.ok(Array.isArray(result[0].matchedProblemIds));
  assert.ok(Array.isArray(result[0].populationProblemIds));
  assert.equal("matchedCount" in result[0], false);
  assert.equal("percentage" in result[0], false);
});

test("repositoryがデフォルト復元Commandと結果型を接続する", async () => {
  const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
  const repository = new SqliteQuestionBankRepository(async <T>(
    command: string,
    args?: Record<string, unknown>,
  ) => {
    calls.push({ command, args });
    return "restored" as unknown as T;
  });

  const result: RestoreDefaultMetricOutcome =
    await repository.restoreDefaultCustomMetric("bank-1", "ever_correct");
  assert.equal(result, "restored");
  assert.deepEqual(calls, [{
    command: "restore_default_custom_metric",
    args: { questionBankId: "bank-1", systemKey: "ever_correct" },
  }]);
});

test("Backendエラーをrepository利用側までrejectで伝播する", async () => {
  const repository = new SqliteQuestionBankRepository(async () => {
    throw new Error("保存済みカスタムメトリクスが不正です");
  });
  await assert.rejects(
    repository.getCustomMetricSummaries("bank-1"),
    /保存済みカスタムメトリクスが不正です/,
  );
});

test("編集系repositoryが各CommandへDTOをそのまま受け渡す", async () => {
  const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
  const metric: CustomMetricDefinitionDto = {
    metricId: "metric-1",
    name: "初見正解",
    icon: "◇",
    definition: DEFAULT_CUSTOM_METRIC_TEMPLATES[0].definition,
    population: DEFAULT_POPULATION_DEFINITION,
    isVisible: true,
    sortOrder: 3,
    origin: "custom",
    systemKey: null,
  };
  const input: CustomMetricWriteInput = {
    name: metric.name,
    icon: metric.icon,
    definition: metric.definition,
    population: metric.population,
    isVisible: metric.isVisible,
  };
  const repository = new SqliteQuestionBankRepository(async <T>(
    command: string,
    args?: Record<string, unknown>,
  ) => {
    calls.push({ command, args });
    if (command === "list_custom_metrics" || command === "move_custom_metric") {
      return [metric] as T;
    }
    if (command === "delete_custom_metric") return undefined as T;
    return metric as T;
  });

  assert.deepEqual(await repository.listCustomMetrics("bank-1"), [metric]);
  assert.deepEqual(await repository.createCustomMetric("bank-1", input), metric);
  assert.deepEqual(await repository.updateCustomMetric("metric-1", input), metric);
  assert.deepEqual(await repository.setCustomMetricVisibility("metric-1", false), metric);
  assert.deepEqual(await repository.moveCustomMetric("metric-1", 0), [metric]);
  await repository.deleteCustomMetric("metric-1");

  assert.deepEqual(calls, [
    { command: "list_custom_metrics", args: { questionBankId: "bank-1" } },
    { command: "create_custom_metric", args: { questionBankId: "bank-1", input } },
    { command: "update_custom_metric", args: { metricId: "metric-1", input } },
    {
      command: "set_custom_metric_visibility",
      args: { metricId: "metric-1", isVisible: false },
    },
    { command: "move_custom_metric", args: { metricId: "metric-1", newSortOrder: 0 } },
    { command: "delete_custom_metric", args: { metricId: "metric-1" } },
  ]);
});

test("構造化された編集系Backendエラーを変更せず伝播する", async () => {
  const backendError: CustomMetricManagementError = {
    kind: "validation",
    message: "メトリクス名を入力してください。",
  };
  const repository = new SqliteQuestionBankRepository(async () => {
    throw backendError;
  });
  await assert.rejects(
    repository.createCustomMetric("bank-1", {
      name: "",
      definition: DEFAULT_CUSTOM_METRIC_TEMPLATES[0].definition,
      population: DEFAULT_POPULATION_DEFINITION,
      isVisible: true,
    }),
    (error) => {
      assert.deepEqual(error, backendError);
      return true;
    },
  );
});

test("設定全体リセットCommandへQuestion Bank IDを渡す", async () => {
  const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
  const repository = new SqliteQuestionBankRepository(async <T>(
    command: string,
    args?: Record<string, unknown>,
  ) => {
    calls.push({ command, args });
    return [] as T;
  });
  assert.deepEqual(await repository.resetCustomMetrics("bank-1"), []);
  assert.deepEqual(calls, [{
    command: "reset_custom_metrics",
    args: { questionBankId: "bank-1" },
  }]);
});
