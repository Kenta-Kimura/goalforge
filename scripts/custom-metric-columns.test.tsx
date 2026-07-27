import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  buildCustomMetricColumns,
  customMetricTooltip,
  customMetricCellText,
  formatCustomMetricProgress,
  getCustomMetricCellState,
  getCustomMetricProgress,
  matchesCustomMetricFilters,
} from "../src/questionBank/customMetricColumns";
import {
  CustomMetricCell,
  CustomMetricHeader,
  CustomMetricFilterControls,
  CustomMetricOverallSummary,
} from "../src/questionBank/QuestionBankView";
import {
  notifyCustomMetricsChanged,
  subscribeToCustomMetricChanges,
} from "../src/questionBank/customMetricEvents";
import {
  DEFAULT_CUSTOM_METRIC_TEMPLATES,
  DEFAULT_POPULATION_DEFINITION,
  type CustomMetricDefinitionDto,
  type CustomMetricSummary,
} from "../src/questionBank/customMetrics";

function definition(
  metricId: string,
  sortOrder: number,
  isVisible = true,
): CustomMetricDefinitionDto {
  return {
    metricId,
    name: `名称${metricId}`,
    icon: `記号${metricId}`,
    definition: DEFAULT_CUSTOM_METRIC_TEMPLATES[0].definition,
    population: DEFAULT_POPULATION_DEFINITION,
    isVisible,
    sortOrder,
    origin: "custom",
    systemKey: null,
  };
}

function summary(
  metricId: string,
  matchedProblemIds: string[] = [],
  populationProblemIds: string[] = [],
): CustomMetricSummary {
  return {
    metricId,
    metricName: `集計${metricId}`,
    matchedProblemIds,
    populationProblemIds,
  };
}

test("Metricなしでは動的列を追加しない", () => {
  assert.deepEqual(buildCustomMetricColumns([], []), []);
  assert.deepEqual(buildCustomMetricColumns([definition("missing", 0)], []), []);
});

test("1件の表示Metricを1列へ変換する", () => {
  const columns = buildCustomMetricColumns(
    [definition("one", 0)],
    [summary("one", ["p1"], ["p1", "p2"])],
  );
  assert.equal(columns.length, 1);
  assert.equal(columns[0].metricId, "one");
  assert.equal(columns[0].matchedProblemIds.has("p1"), true);
});

test("複数列をsortOrder順にし、表示OFFを除外する", () => {
  const columns = buildCustomMetricColumns(
    [
      definition("third", 2),
      definition("hidden", 0, false),
      definition("first", 0),
      definition("second", 1),
    ],
    [
      summary("first"),
      summary("second"),
      summary("third"),
      summary("hidden"),
    ],
  );
  assert.deepEqual(columns.map((column) => column.metricId), [
    "first",
    "second",
    "third",
  ]);
});

test("達成は○、未達は空、Population対象外は—を表示する", () => {
  const column = buildCustomMetricColumns(
    [definition("status", 0)],
    [summary("status", ["matched"], ["matched", "unmatched"])],
  )[0];
  assert.equal(customMetricCellText(getCustomMetricCellState(column, "matched")), "○");
  assert.equal(customMetricCellText(getCustomMetricCellState(column, "unmatched")), "");
  assert.equal(customMetricCellText(getCustomMetricCellState(column, "outside")), "—");

  const matchedHtml = renderToStaticMarkup(
    <CustomMetricCell column={column} problemId="matched" />,
  );
  const unmatchedHtml = renderToStaticMarkup(
    <CustomMetricCell column={column} problemId="unmatched" />,
  );
  const outsideHtml = renderToStaticMarkup(
    <CustomMetricCell column={column} problemId="outside" />,
  );
  assert.match(matchedHtml, />○</);
  assert.match(unmatchedHtml, /未達成/);
  assert.doesNotMatch(unmatchedHtml, />○</);
  assert.match(outsideHtml, />—</);
});

test("ヘッダーにアイコン・名前・Tooltipを表示する", () => {
  const column = buildCustomMetricColumns(
    [definition("header", 0)],
    [summary("header")],
  )[0];
  const html = renderToStaticMarkup(<CustomMetricHeader column={column} />);
  assert.match(html, /記号header/);
  assert.match(html, /名称header/);
  assert.match(html, /title="名称header/);
  assert.match(html, /Population: 0問/);
  assert.match(html, /達成率: —/);
});

test("0%・100%・途中の達成率を既存ID集合から算出する", () => {
  const population = Array.from({ length: 20 }, (_, index) => `p${index + 1}`);
  const cases = [
    { id: "zero", matched: [] as string[], expected: "0 / 20 (0%)" },
    { id: "full", matched: population, expected: "20 / 20 (100%)" },
    { id: "partial", matched: population.slice(0, 17), expected: "17 / 20 (85%)" },
  ];
  for (const item of cases) {
    const column = buildCustomMetricColumns(
      [definition(item.id, 0)],
      [summary(item.id, item.matched, population)],
    )[0];
    assert.equal(
      formatCustomMetricProgress(getCustomMetricProgress(column)),
      item.expected,
    );
  }
});

test("Population 0件では達成率の代わりに—を表示する", () => {
  const column = buildCustomMetricColumns(
    [definition("empty-population", 0)],
    [summary("empty-population", [], [])],
  )[0];
  const progress = getCustomMetricProgress(column);
  assert.equal(progress.achievementRate, null);
  assert.equal(formatCustomMetricProgress(progress), "—");
  const html = renderToStaticMarkup(<CustomMetricHeader column={column} />);
  assert.match(html, />—</);
});

test("ツールチップへPopulation・達成・未達・達成率を表示する", () => {
  const population = Array.from({ length: 20 }, (_, index) => `p${index + 1}`);
  const column = buildCustomMetricColumns(
    [definition("tooltip", 0)],
    [summary("tooltip", population.slice(0, 17), population)],
  )[0];
  const tooltip = customMetricTooltip(column);
  assert.match(tooltip, /Population: 20問/);
  assert.match(tooltip, /達成: 17問/);
  assert.match(tooltip, /未達: 3問/);
  assert.match(tooltip, /達成率: 85%/);
});

test("作成・編集・削除・復元・表示切替通知をQuestionBankViewの再取得契機へ伝える", () => {
  const originalWindow = globalThis.window;
  const events = new EventTarget();
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: events,
  });
  const received: string[] = [];
  const unsubscribe = subscribeToCustomMetricChanges((questionBankId) => {
    received.push(questionBankId);
  });
  for (const change of ["create", "edit", "delete", "restore", "visibility"]) {
    notifyCustomMetricsChanged(`bank-${change}`);
  }
  unsubscribe();
  notifyCustomMetricsChanged("bank-after-unsubscribe");
  assert.deepEqual(received, [
    "bank-create",
    "bank-edit",
    "bank-delete",
    "bank-restore",
    "bank-visibility",
  ]);
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: originalWindow,
  });
});

test("教材全体の集計を専用Summaryへ1回だけ表示する", () => {
  const population = Array.from({ length: 20 }, (_, index) => `p${index + 1}`);
  const column = buildCustomMetricColumns(
    [definition("overall", 0)],
    [summary("overall", population.slice(0, 17), population)],
  )[0];
  const html = renderToStaticMarkup(
    <CustomMetricOverallSummary columns={[column]} loading={false} />,
  );
  assert.match(html, /教材全体/);
  assert.match(html, /17 \/ 20 \(85%\)/);
  assert.equal((html.match(/17 \/ 20 \(85%\)/g) ?? []).length, 1);
});

test("セクションごとにPopulationとMatchedの積集合を集計する", () => {
  const sectionA = Array.from({ length: 20 }, (_, index) => `a${index + 1}`);
  const sectionB = Array.from({ length: 40 }, (_, index) => `b${index + 1}`);
  const population = [...sectionA, ...sectionB];
  const matched = [...sectionA.slice(0, 18), ...sectionB.slice(0, 25)];
  const column = buildCustomMetricColumns(
    [definition("sections", 0)],
    [summary("sections", matched, population)],
  )[0];

  assert.equal(
    formatCustomMetricProgress(getCustomMetricProgress(column, sectionA)),
    "18 / 20 (90%)",
  );
  assert.equal(
    formatCustomMetricProgress(getCustomMetricProgress(column, sectionB)),
    "25 / 40 (63%)",
  );
  assert.equal(
    formatCustomMetricProgress(getCustomMetricProgress(column)),
    "43 / 60 (72%)",
  );
});

test("対象Populationがないセクションは—を表示する", () => {
  const column = buildCustomMetricColumns(
    [definition("empty-section", 0)],
    [summary("empty-section", ["other"], ["other"])],
  )[0];
  assert.equal(
    formatCustomMetricProgress(getCustomMetricProgress(column, ["section-only"])),
    "—",
  );
});

test("セクションTooltipはそのセクションだけの値を表示する", () => {
  const section = Array.from({ length: 20 }, (_, index) => `s${index + 1}`);
  const column = buildCustomMetricColumns(
    [definition("section-tooltip", 0)],
    [summary("section-tooltip", section.slice(0, 17), [...section, "outside"])],
  )[0];
  const tooltip = customMetricTooltip(column, section, "IAM");
  assert.match(tooltip, /IAM \/ 名称section-tooltip/);
  assert.match(tooltip, /Population: 20問/);
  assert.match(tooltip, /達成: 17問/);
  assert.match(tooltip, /未達: 3問/);
  assert.match(tooltip, /達成率: 85%/);
});

test("更新後のID集合から教材全体とセクション集計を再計算する", () => {
  const definitions = [definition("updated", 0)];
  const before = buildCustomMetricColumns(
    definitions,
    [summary("updated", ["a1"], ["a1", "a2", "b1"])],
  )[0];
  const after = buildCustomMetricColumns(
    definitions,
    [summary("updated", ["a1", "a2", "b1"], ["a1", "a2", "b1"])],
  )[0];
  assert.equal(
    formatCustomMetricProgress(getCustomMetricProgress(before, ["a1", "a2"])),
    "1 / 2 (50%)",
  );
  assert.equal(
    formatCustomMetricProgress(getCustomMetricProgress(after, ["a1", "a2"])),
    "2 / 2 (100%)",
  );
  assert.equal(
    formatCustomMetricProgress(getCustomMetricProgress(after)),
    "3 / 3 (100%)",
  );
});

test("未指定・達成・未達で問題を判定する", () => {
  const column = buildCustomMetricColumns(
    [definition("filter", 0)],
    [summary("filter", ["matched"], ["matched", "unmatched"])],
  )[0];
  assert.equal(
    matchesCustomMetricFilters("matched", [column], {}),
    true,
  );
  assert.equal(
    matchesCustomMetricFilters("outside", [column], {}),
    true,
  );
  assert.equal(
    matchesCustomMetricFilters("matched", [column], { filter: "matched" }),
    true,
  );
  assert.equal(
    matchesCustomMetricFilters("unmatched", [column], { filter: "matched" }),
    false,
  );
  assert.equal(
    matchesCustomMetricFilters("unmatched", [column], { filter: "unmatched" }),
    true,
  );
  assert.equal(
    matchesCustomMetricFilters("outside", [column], { filter: "unmatched" }),
    false,
  );
});

test("複数メトリクスをAND条件で判定する", () => {
  const columns = buildCustomMetricColumns(
    [definition("first-filter", 0), definition("second-filter", 1)],
    [
      summary("first-filter", ["p1", "p2"], ["p1", "p2", "p3"]),
      summary("second-filter", ["p2"], ["p1", "p2"]),
    ],
  );
  const selections = {
    "first-filter": "matched",
    "second-filter": "unmatched",
  } as const;
  assert.equal(matchesCustomMetricFilters("p1", columns, selections), true);
  assert.equal(matchesCustomMetricFilters("p2", columns, selections), false);
  assert.equal(matchesCustomMetricFilters("p3", columns, selections), false);
  // 既存フィルタの結果ともANDで結合される。
  assert.equal(true && matchesCustomMetricFilters("p1", columns, selections), true);
  assert.equal(false && matchesCustomMetricFilters("p1", columns, selections), false);
});

test("フィルタUIは表示ONのメトリクスだけをsortOrder順に表示する", () => {
  const columns = buildCustomMetricColumns(
    [
      definition("second-visible", 1),
      definition("hidden-filter", 0, false),
      definition("first-visible", 0),
    ],
    [
      summary("second-visible"),
      summary("hidden-filter"),
      summary("first-visible"),
    ],
  );
  const html = renderToStaticMarkup(
    <CustomMetricFilterControls
      columns={columns}
      selections={{}}
      onChange={() => undefined}
    />,
  );
  assert.match(html, /カスタムメトリクス/);
  assert.match(html, /未指定/);
  assert.match(html, /達成/);
  assert.match(html, /未達/);
  assert.doesNotMatch(html, /名称hidden-filter/);
  assert.doesNotMatch(html, /type="checkbox"/);
  assert.ok(html.indexOf("名称first-visible") < html.indexOf("名称second-visible"));
});

test("削除・復元・並び替え後の定義からフィルタ候補を再構築する", () => {
  const summaries = [
    summary("restored"),
    summary("remaining"),
  ];
  const afterDelete = buildCustomMetricColumns(
    [definition("remaining", 0)],
    summaries,
  );
  assert.deepEqual(afterDelete.map((column) => column.metricId), ["remaining"]);
  assert.equal(
    matchesCustomMetricFilters("p1", afterDelete, { restored: "matched" }),
    false,
  );

  const afterRestoreAndMove = buildCustomMetricColumns(
    [definition("remaining", 1), definition("restored", 0)],
    summaries,
  );
  assert.deepEqual(
    afterRestoreAndMove.map((column) => column.metricId),
    ["restored", "remaining"],
  );
});
