import React from "react";
import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  AnswerPanel,
  AttemptEditForm,
  HistoryPanel,
  LearningRoundSummary,
  ProblemList,
  PracticeRoundHistoryMarks,
  groupProblemsByContentLabel,
} from "../src/questionBank/QuestionBankView";
import type { ProblemAttempt, QuestionBank } from "../src/questionBank/types";

test("教材切替時は表示対象の教材だけから周回サマリーを描画する", () => {
  const first = renderToStaticMarkup(
    <LearningRoundSummary bank={bank("first", [
      attempt("first-1", 1, 1),
      attempt("first-2", 2, 0),
    ])} />,
  );
  const second = renderToStaticMarkup(
    <LearningRoundSummary bank={bank("second", [
      attempt("second-1", 1, 0),
    ])} />,
  );

  assert.match(first, /1周目/);
  assert.match(first, /1 \/ 1 \(100\.0%\)/);
  assert.match(first, /2周目/);
  assert.match(first, /0 \/ 1 \(0\.0%\)/);
  assert.match(second, /1周目/);
  assert.match(second, /0 \/ 1 \(0\.0%\)/);
  assert.doesNotMatch(second, /2周目/);
});

test("未回答の教材では空状態を表示する", () => {
  const html = renderToStaticMarkup(<LearningRoundSummary bank={bank("empty", [])} />);
  assert.match(html, /解答履歴はまだありません/);
});

test("問題一覧の解答履歴はNumbersの周回位置を維持し、空欄を-で表示する", () => {
  const target = bank("history", [
    attempt("history-2", 1, 1),
  ]);
  target.rounds = [1, 2, 3].map((roundNumber) => ({
    id: `round-${roundNumber}`,
    questionBankId: target.id,
    roundNumber,
    startedAt: "2026-07-01T00:00:00.000Z",
    targetProblemIds: ["problem-1"],
  }));
  target.sections[0].problems[0].attempts[0].roundId = "round-2";

  const html = renderToStaticMarkup(
    <PracticeRoundHistoryMarks bank={target} problem={target.sections[0].problems[0]} />,
  );
  assert.match(html, /1周目、解答履歴なし/);
  assert.match(html, /2周目、○/);
  assert.match(html, /3周目、解答履歴なし/);
  assert.equal((html.match(/>-</g) ?? []).length, 2);
});

test("解答履歴列の履歴マークを直接編集ボタンとして表示する", () => {
  const target = bank("direct-edit", [attempt("direct-edit-1", 1, 1)]);
  target.sections[0].problems[0].correctAnswer = "③";
  target.sections[0].problems[0].attempts[0].userAnswer = "②";
  const html = renderToStaticMarkup(
    <PracticeRoundHistoryMarks
      bank={target}
      problem={target.sections[0].problems[0]}
      onEditAttempt={() => undefined}
    />,
  );
  assert.match(html, /<button[^>]*class="history-score/);
  assert.match(html, /1周目、○、確信度未設定、正答③、自分の解答②、編集/);
});

test("履歴マークから開いた履歴は対象解答を最初から編集表示する", () => {
  const target = bank("direct-edit-panel", [attempt("direct-edit-panel-1", 1, 1)]);
  const targetAttempt = target.sections[0].problems[0].attempts[0];
  const html = renderToStaticMarkup(
    <HistoryPanel
      bank={target}
      problem={target.sections[0].problems[0]}
      initialEditingAttemptId={targetAttempt.id}
      onClose={() => undefined}
      onChanged={async () => undefined}
      onAdd={() => undefined}
    />,
  );
  assert.match(html, /history-entry history-entry-editing/);
  assert.match(html, />保存</);
});

test("履歴ダイアログでは-の周回から解答を追加できる", () => {
  const target = bank("history-dialog", [
    attempt("history-dialog-2", 1, 1),
  ]);
  target.rounds = [1, 2].map((roundNumber) => ({
    id: `round-${roundNumber}`,
    questionBankId: target.id,
    roundNumber,
    startedAt: "2026-07-01T00:00:00.000Z",
    targetProblemIds: ["problem-1"],
  }));
  target.sections[0].problems[0].attempts[0].roundId = "round-2";

  const html = renderToStaticMarkup(
    <HistoryPanel
      bank={target}
      problem={target.sections[0].problems[0]}
      onClose={() => undefined}
      onChanged={async () => undefined}
      onAdd={() => undefined}
    />,
  );
  assert.match(html, /1周目/);
  assert.match(html, /解答を追加/);
  assert.match(html, /2周目/);
  assert.match(html, />編集</);
});

test("履歴編集フォームは履歴詳細と同じ項目配置で既存値を表示する", () => {
  const targetAttempt: ProblemAttempt = {
    ...attempt("attempt-edit", 2, 0.5),
    answeredAt: "2026-08-08T01:30:00.000Z",
    maxScore: 1,
    confidence: "medium",
    note: "補語を復習",
  };
  const html = renderToStaticMarkup(
    <AttemptEditForm
      attempt={targetAttempt}
      roundNumber={2}
      onCancel={() => undefined}
      onSaved={async () => undefined}
    />,
  );

  assert.match(html, /class="history-entry history-entry-editing"/);
  assert.match(html, /2周目/);
  assert.match(html, />日時</);
  assert.doesNotMatch(html, /type="datetime-local"[^>]*required/);
  assert.match(html, />得点</);
  assert.match(html, /50\.0%/);
  assert.match(html, />確信度</);
  assert.match(html, />メモ</);
  assert.match(html, /value="medium" selected=""/);
  assert.match(html, /<textarea[^>]*rows="3"[^>]*>補語を復習<\/textarea>/);
  assert.match(html, />キャンセル</);
  assert.match(html, />保存</);
});

test("解答追加フォームで未入力の周回を選択できる", () => {
  const target = bank("answer-form", [
    attempt("answer-form-2", 1, 1),
  ]);
  target.rounds = [1, 2, 3].map((roundNumber) => ({
    id: `round-${roundNumber}`,
    questionBankId: target.id,
    roundNumber,
    startedAt: "2026-07-01T00:00:00.000Z",
    targetProblemIds: ["problem-1"],
  }));
  target.sections[0].problems[0].attempts[0].roundId = "round-2";
  target.sections[0].problems[0].defaultMaxScore = 2.5;
  target.sections[0].problems[0].correctAnswer = "A";

  const html = renderToStaticMarkup(
    <AnswerPanel
      bank={target}
      problem={target.sections[0].problems[0]}
      roundId="round-1"
      onClose={() => undefined}
      onSaved={async () => undefined}
    />,
  );
  assert.match(html, /<label>周回/);
  assert.match(html, /value="round-1" selected="">1周目/);
  assert.doesNotMatch(html, /value="round-2"/);
  assert.match(html, /value="round-3">3周目/);
  assert.match(html, />自分の解答/);
  assert.match(html, /placeholder="例: A、③、○"/);
  assert.match(html, /保存後に正誤と得点を自動判定します。/);
  assert.doesNotMatch(html, /○ 正解/);
  assert.doesNotMatch(html, /× 不正解/);
  assert.doesNotMatch(html, /aria-label="獲得点"/);
  assert.doesNotMatch(html, /解答日時/);
  assert.doesNotMatch(html, /type="datetime-local"/);
});

test("問題一覧はセクションをタブ表示し、選択中のセクションだけを描画する", () => {
  const target = bank("section-tabs", []);
  target.sections[0].title = "STEP 1";
  target.sections[0].problems[0].number = "①";
  target.sections[0].problems[0].title = "最初の問題";
  target.sections.push({
    ...target.sections[0],
    id: "section-second",
    title: "STEP 2",
    problems: [{
      ...target.sections[0].problems[0],
      id: "problem-second",
      sectionId: "section-second",
      title: "次の問題",
    }],
  });

  const html = renderToStaticMarkup(
    <ProblemList
      bank={target}
      metricColumns={[]}
      metricLoading={false}
      metricError=""
      customMetricFilters={{}}
      setCustomMetricFilters={() => undefined}
      onReloadMetrics={() => undefined}
      filters={{ statuses: [], results: [], confidences: [], latestFrom: "", latestTo: "" }}
      setFilters={() => undefined}
      selectedProblemIds={[]}
      setSelectedProblemIds={() => undefined}
      onStatus={() => undefined}
      onHistory={() => undefined}
      onAnswer={() => undefined}
    />,
  );

  assert.match(html, /role="tablist"/);
  assert.match(html, /role="tab" aria-selected="true"[^>]*><strong>STEP 1<\/strong>/);
  assert.match(html, /role="tab" aria-selected="false"[^>]*><strong>STEP 2<\/strong>/);
  assert.match(html, /role="tabpanel"/);
  assert.match(html, /<strong>①<\/strong>/);
  assert.doesNotMatch(html, /No\.①/);
  assert.match(html, /最初の問題/);
  assert.doesNotMatch(html, /次の問題/);
});

test("選択中のセクションを内容ラベル単位にグループ化する", () => {
  const target = bank("content-label-groups", []);
  const first = target.sections[0].problems[0];
  const problems = [
    { ...first, id: "p1", title: "語順選択" },
    { ...first, id: "p2", title: "語順選択" },
    { ...first, id: "p3", title: "日文中訳" },
    { ...first, id: "p4", title: "" },
  ];

  assert.deepEqual(
    groupProblemsByContentLabel(problems).map((group) => ({
      label: group.label,
      problemIds: group.problems.map((problem) => problem.id),
    })),
    [
      { label: "語順選択", problemIds: ["p1", "p2"] },
      { label: "日文中訳", problemIds: ["p3"] },
      { label: "", problemIds: ["p4"] },
    ],
  );
});

function attempt(id: string, attemptNumber: number, earnedScore: number): ProblemAttempt {
  return {
    id,
    problemId: "problem-1",
    roundId: `round-${attemptNumber}`,
    answeredAt: null,
    attemptNumber,
    earnedScore,
    maxScore: 1,
    confidence: null,
  };
}

function bank(id: string, attempts: ProblemAttempt[]): QuestionBank {
  const roundNumbers = [...new Set(attempts.map((item) => Number(item.roundId.replace("round-", ""))))];
  return {
    id,
    materialId: `material-${id}`,
    title: id,
    sections: [{
      id: `section-${id}`,
      questionBankId: id,
      title: "Section",
      order: 0,
      evaluationType: "binary",
      isMockExamSection: false,
      problems: [{
        id: "problem-1",
        sectionId: `section-${id}`,
        number: "1",
        order: 0,
        defaultMaxScore: 1,
        reviewStatus: "active",
        attempts,
      }],
    }],
    rounds: roundNumbers.map((roundNumber) => ({
      id: `round-${roundNumber}`,
      questionBankId: id,
      roundNumber,
      startedAt: "2026-07-01T00:00:00.000Z",
      targetProblemIds: ["problem-1"],
    })),
  };
}
