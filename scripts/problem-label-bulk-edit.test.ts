import assert from "node:assert/strict";
import test from "node:test";
import {
  applyProblemFormatToAll,
  applyProblemLabelToSelected,
  applyProblemMaxScoreToAll,
  copyProblemLabelToFollowing,
  renumberProblemsByLabel,
  removeProblemNumberFromLabels,
  wrapProblemNumbers,
  type ProblemLabelDraft,
} from "../src/questionBank/MaterialMasterView";

const drafts: ProblemLabelDraft[] = [
  { id: "one", number: "1", title: "問1 結果補語", evaluationTypeOverride: "binary", defaultMaxScore: 1 },
  { id: "two", number: "2", title: "語順整序 (2)", evaluationTypeOverride: "partial_score", defaultMaxScore: 2 },
  { id: "three", number: "(3)", title: "内容ラベル", defaultMaxScore: 3 },
];

test("教材上の番号を二重括弧にせず一括で括弧表記へ変換する", () => {
  assert.deepEqual(
    wrapProblemNumbers(drafts).map((draft) => draft.number),
    ["(1)", "(2)", "(3)"],
  );
});

test("内容ラベルの先頭・末尾にある問題番号表記だけを削除する", () => {
  assert.deepEqual(
    removeProblemNumberFromLabels(drafts).map((draft) => draft.title),
    ["結果補語", "語順整序", "内容ラベル"],
  );
});

test("選択した問題の内容ラベルを次の問題から末尾までコピーする", () => {
  const copied = copyProblemLabelToFollowing(drafts, "two");
  assert.deepEqual(
    copied.map((draft) => draft.title),
    ["問1 結果補語", "語順整序 (2)", "語順整序 (2)"],
  );
  assert.deepEqual(
    copied.map((draft) => [draft.evaluationTypeOverride, draft.defaultMaxScore]),
    [["binary", 1], ["partial_score", 2], [undefined, 3]],
  );
  assert.equal(copyProblemLabelToFollowing(drafts, "missing"), drafts);
});

test("問題形式と配点を全問題へ一括反映する", () => {
  const formatted = applyProblemFormatToAll(drafts, "partial_score");
  assert.deepEqual(formatted.map((draft) => draft.evaluationTypeOverride), ["partial_score", "partial_score", "partial_score"]);

  const scored = applyProblemMaxScoreToAll(formatted, 4);
  assert.deepEqual(scored.map((draft) => draft.defaultMaxScore), [4, 4, 4]);
  assert.deepEqual(scored.map((draft) => draft.title), drafts.map((draft) => draft.title));
});

test("内容ラベルを複数選択した問題だけへ反映する", () => {
  const updated = applyProblemLabelToSelected(drafts, new Set(["one", "three"]), "選択式");
  assert.deepEqual(updated.map((draft) => draft.title), ["選択式", "語順整序 (2)", "選択式"]);
});

test("内容ラベルが変わるたび番号を1から振り直し、番号表記を維持する", () => {
  const renumbered = renumberProblemsByLabel([
    { ...drafts[0], number: "(8)", title: "空欄補充" },
    { ...drafts[1], number: "(9)", title: "空欄補充" },
    { ...drafts[2], number: "No.15", title: "語順整序" },
    { ...drafts[0], id: "four", number: "No.16", title: "語順整序" },
    { ...drafts[1], id: "five", number: "⑧", title: "日文中訳" },
    { ...drafts[2], id: "six", number: "⑨", title: "日文中訳" },
  ]);

  assert.deepEqual(renumbered.map((draft) => draft.number), [
    "(1)", "(2)", "No.1", "No.2", "①", "②",
  ]);
});
