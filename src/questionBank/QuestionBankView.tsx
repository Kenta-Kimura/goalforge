import React, { FormEvent, MouseEvent, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { isTauriRuntime } from "../lib/tauri";
import {
  calculateBankSummary,
  calculateMockExamSummary,
  calculatePracticeRoundAccuracies,
  calculateRoundSummary,
  deriveScoreResult,
  getPracticeRoundHistory,
  latestAttempt,
  matchesFilter,
} from "./analytics";
import { formatAttemptDate, formatAttemptDay } from "./presentation";
import {
  buildCustomMetricColumns,
  customMetricTooltip,
  customMetricCellText,
  formatCustomMetricProgress,
  getCustomMetricCellState,
  getCustomMetricProgress,
  matchesCustomMetricFilters,
  type CustomMetricColumn,
  type CustomMetricFilterMode,
  type CustomMetricFilterSelections,
} from "./customMetricColumns";
import { subscribeToCustomMetricChanges } from "./customMetricEvents";
import { SqliteQuestionBankRepository } from "./repository";
import { QuestionBankService } from "./service";
import type {
  Confidence,
  Problem,
  ProblemAttempt,
  ProblemReviewStatus,
  QuestionBank,
  QuestionFilters,
} from "./types";

const service = new QuestionBankService(new SqliteQuestionBankRepository());
const repository = new SqliteQuestionBankRepository();
const initialFilters: QuestionFilters = {
  statuses: [],
  results: [],
  confidences: [],
  latestFrom: "",
  latestTo: "",
};
const statusLabels: Record<ProblemReviewStatus, string> = {
  active: "継続",
  completed: "終了",
  paused: "保留",
  excluded: "除外",
};
const confidenceLabels: Record<string, string> = {
  high: "高",
  medium: "中",
  low: "低",
};

export function ExerciseView() {
  const [banks, setBanks] = useState<QuestionBank[]>([]);
  const [selectedBankId, setSelectedBankId] = useState("");
  const [filters, setFilters] = useState<QuestionFilters>(initialFilters);
  const [selectedProblemIds, setSelectedProblemIds] = useState<string[]>([]);
  const [activeMockRoundId, setActiveMockRoundId] = useState("");
  const [answerRequest, setAnswerRequest] = useState<{ problemId: string; roundId: string } | null>(null);
  const [historyProblemId, setHistoryProblemId] = useState("");
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(isTauriRuntime());
  const [metricColumns, setMetricColumns] = useState<CustomMetricColumn[]>([]);
  const [metricLoading, setMetricLoading] = useState(false);
  const [metricError, setMetricError] = useState("");
  const [customMetricFilters, setCustomMetricFilters] =
    useState<CustomMetricFilterSelections>({});
  const metricRequestId = useRef(0);

  async function refresh(preferredBankId?: string) {
    try {
      const next = await service.list();
      setBanks(next);
      setSelectedBankId((current) => preferredBankId || current || next[0]?.id || "");
    } catch (error) {
      setMessage(toMessage(error));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (isTauriRuntime()) void refresh();
  }, []);

  async function refreshMetricColumns(questionBankId: string) {
    const requestId = metricRequestId.current + 1;
    metricRequestId.current = requestId;
    setMetricColumns([]);
    setMetricLoading(true);
    setMetricError("");
    try {
      const [definitions, summaries] = await Promise.all([
        repository.listCustomMetrics(questionBankId),
        repository.getCustomMetricSummaries(questionBankId),
      ]);
      if (metricRequestId.current === requestId) {
        const nextColumns = buildCustomMetricColumns(definitions, summaries);
        setMetricColumns(nextColumns);
        const visibleMetricIds = new Set(nextColumns.map((column) => column.metricId));
        setCustomMetricFilters((current) => Object.fromEntries(
          Object.entries(current).filter(([metricId]) => visibleMetricIds.has(metricId)),
        ));
      }
    } catch (error) {
      if (metricRequestId.current === requestId) {
        setMetricColumns([]);
        setMetricError(toMessage(error));
      }
    } finally {
      if (metricRequestId.current === requestId) setMetricLoading(false);
    }
  }

  useEffect(() => {
    if (!isTauriRuntime() || !selectedBankId) {
      metricRequestId.current += 1;
      setMetricColumns([]);
      return;
    }
    void refreshMetricColumns(selectedBankId);
  }, [banks, selectedBankId]);

  useEffect(() => {
    setCustomMetricFilters({});
  }, [selectedBankId]);

  useEffect(() => subscribeToCustomMetricChanges((questionBankId) => {
    if (questionBankId === selectedBankId) void refreshMetricColumns(questionBankId);
  }), [selectedBankId]);

  const bank = banks.find((item) => item.id === selectedBankId);
  const problems = useMemo(() => bank?.sections.flatMap((section) => section.problems) ?? [], [bank]);
  const answerProblem = problems.find((problem) => problem.id === answerRequest?.problemId);
  const historyProblem = problems.find((problem) => problem.id === historyProblemId);

  if (!isTauriRuntime()) {
    return (
      <div className="panel desktop-required">
        <h2>演習はデスクトップ版で利用します</h2>
        <p>学習データをSQLiteへ安全に保存するため、この画面は「npm run tauri:dev」で起動したGoalForgeで利用できます。</p>
      </div>
    );
  }

  async function run(action: () => Promise<unknown>, success: string) {
    try {
      setMessage("");
      await action();
      await refresh();
      setMessage(success);
    } catch (error) {
      setMessage(toMessage(error));
    }
  }

  return (
    <section className="question-bank-layout">
      {message && <div className="question-message" role="status">{message}</div>}
      <div className="question-bank-toolbar panel">
        <div>
          <span className="eyebrow">SQLite</span>
          <h2>演習</h2>
        </div>
      </div>

      {loading && <div className="panel">教材を読み込んでいます…</div>}
      {!loading && banks.length === 0 && (
        <div className="panel empty-state">
          <h3>演習できる教材がありません</h3>
          <p>先に「教材管理」で教材・セクション・問題を登録してください。</p>
        </div>
      )}

      {banks.length > 0 && (
        <>
          <div className="panel bank-selector">
            <label>
              教材を選択
              <select value={selectedBankId} onChange={(event) => setSelectedBankId(event.target.value)}>
                {banks.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}
              </select>
            </label>
          </div>
          {bank && (
            <>
              <BankSummary bank={bank} />
              <LearningRoundSummary bank={bank} />
              <CustomMetricOverallSummary
                columns={metricColumns}
                loading={metricLoading}
              />
              <MockExamPanel
                bank={bank}
                activeRoundId={activeMockRoundId}
                onSelectRound={(id) => {
                  setActiveMockRoundId(id);
                }}
                onCreate={() =>
                  run(async () => {
                    const problemIds = mockProblemIds(bank);
                    const round = await service.createRound(bank.id, "manual", problemIds);
                    setActiveMockRoundId(round.id);
                  }, "模試を開始しました。")
                }
                onComplete={(roundId) => run(() => service.completeRound(roundId), "模試を完了しました。")}
              />
              <ProblemList
                bank={bank}
                metricColumns={metricColumns}
                metricLoading={metricLoading}
                metricError={metricError}
                customMetricFilters={customMetricFilters}
                setCustomMetricFilters={setCustomMetricFilters}
                onReloadMetrics={() => void refreshMetricColumns(bank.id)}
                filters={filters}
                setFilters={setFilters}
                selectedProblemIds={selectedProblemIds}
                setSelectedProblemIds={setSelectedProblemIds}
                onStatus={(ids, status) =>
                  run(async () => {
                    await service.updateStatuses(ids, status);
                    setSelectedProblemIds([]);
                  }, "復習状態を更新しました。")
                }
                onHistory={setHistoryProblemId}
                onAnswer={async (problemId) => {
                  const targetProblem = problems.find((problem) => problem.id === problemId);
                  const answeredRoundIds = new Set(
                    targetProblem?.attempts.map((attempt) => attempt.roundId) ?? [],
                  );
                  const activeMockRound = bank.rounds.find(
                    (item) =>
                      item.id === activeMockRoundId &&
                      !item.completedAt &&
                      item.targetProblemIds.includes(problemId) &&
                      !answeredRoundIds.has(item.id),
                  );
                  let round = activeMockRound ?? [...bank.rounds]
                      .reverse()
                      .find((item) => (
                        !item.completedAt
                        && !isMockRound(bank, item)
                        && !answeredRoundIds.has(item.id)
                      ));
                  if (!round) {
                    try {
                      round = await service.createRound(bank.id, "all");
                      await refresh();
                    } catch (error) {
                      setMessage(toMessage(error));
                      return;
                    }
                  }
                  setAnswerRequest({ problemId, roundId: round.id });
                }}
              />
              {answerRequest && answerProblem && (
                <ModalBackdrop onClose={() => setAnswerRequest(null)}>
                  <AnswerPanel
                    bank={bank}
                    problem={answerProblem}
                    roundId={answerRequest.roundId}
                    onClose={() => setAnswerRequest(null)}
                    onSaved={async () => {
                      await refresh();
                      setAnswerRequest(null);
                      setMessage("解答を保存しました。");
                    }}
                  />
                </ModalBackdrop>
              )}
              {historyProblem && (
                <HistoryPanel
                  problem={historyProblem}
                  bank={bank}
                  onClose={() => setHistoryProblemId("")}
                  onChanged={refresh}
                  onAdd={(roundId) => {
                    setHistoryProblemId("");
                    setAnswerRequest({ problemId: historyProblem.id, roundId });
                  }}
                />
              )}
            </>
          )}
        </>
      )}
    </section>
  );
}

function BankSummary({ bank }: { bank: QuestionBank }) {
  const summary = calculateBankSummary(bank);
  return (
    <div className="question-summary-grid">
      <SummaryCard label="全問題" value={`${summary.total}問`} />
      <SummaryCard label="初回解答進捗" value={`${summary.answered}/${summary.total}`} />
      <SummaryCard label="復習完了進捗" value={`${summary.completed}/${summary.total}`} />
      <SummaryCard label="継続中" value={`${summary.active}問`} />
      <SummaryCard label="保留" value={`${summary.paused}問`} />
      <SummaryCard label="除外" value={`${summary.excluded}問`} />
    </div>
  );
}

function SummaryCard({ label, value }: { label: string; value: string }) {
  return <div className="panel question-summary-card"><span>{label}</span><strong>{value}</strong></div>;
}

export function LearningRoundSummary({ bank }: { bank: QuestionBank }) {
  const rounds = calculatePracticeRoundAccuracies(bank);
  return (
    <section className="panel learning-round-summary">
      <div>
        <span className="eyebrow">教材全体</span>
        <h2>学習サマリー</h2>
      </div>
      {rounds.length === 0 ? (
        <p className="helper-text">解答履歴はまだありません。</p>
      ) : (
        <div className="learning-round-summary-grid">
          {rounds.map((round) => (
            <div className="learning-round-summary-card" key={round.roundNumber}>
              <small>{round.roundNumber}周目</small>
              <strong>
                {round.correctCount} / {round.problemCount} ({(round.accuracyRate * 100).toFixed(1)}%)
              </strong>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function MockExamPanel({
  bank,
  activeRoundId,
  onSelectRound,
  onCreate,
  onComplete,
}: {
  bank: QuestionBank;
  activeRoundId: string;
  onSelectRound: (id: string) => void;
  onCreate: () => void;
  onComplete: (id: string) => void;
}) {
  const rounds = bank.rounds.filter((item) => isMockRound(bank, item));
  const round = rounds.find((item) => item.id === activeRoundId) ?? rounds.at(-1);
  const summary = round ? calculateRoundSummary(bank, round) : null;
  const mock = round ? calculateMockExamSummary(bank, round) : [];
  if (mockProblemIds(bank).length === 0) return null;
  return (
    <div className="panel round-panel">
      <div className="panel-heading">
        <div><span className="eyebrow">模試</span><h2>模試形式で記録</h2></div>
      </div>
      <p className="helper-text">通常の演習は、下の問題一覧を絞り込んで「解答」から直接記録できます。</p>
      <button className="primary-button" onClick={onCreate}>新しい模試を開始</button>
      {rounds.length > 0 && (
        <label>模試履歴
          <select value={round?.id || ""} onChange={(event) => onSelectRound(event.target.value)}>
            {rounds.map((item, index) => <option key={item.id} value={item.id}>模試 {index + 1}{item.completedAt ? "（完了）" : ""}</option>)}
          </select>
        </label>
      )}
      {round && summary && (
        <>
          <div className="round-stats">
            <span>対象 {summary.target}</span><span>解答済み {summary.answered}</span>
            <span>○ {summary.correct}</span><span>△ {summary.partial}</span><span>× {summary.incorrect}</span>
            <strong>{summary.earnedScore}/{summary.maxScore}点（{summary.scoreRate?.toFixed(1) ?? "—"}%）</strong>
          </div>
          <p className="helper-text">得点率は、この模試で解答した問題を基に算出します。</p>
          {mock.map((item) => (
            <div key={item.sectionId} className="mock-score">
              <strong>{item.title}</strong> {item.earnedScore}/{item.maxScore}点（{item.scoreRate?.toFixed(1)}%）
            </div>
          ))}
          {!round.completedAt && <button onClick={() => onComplete(round.id)}>この模試を完了</button>}
        </>
      )}
    </div>
  );
}

function mockProblemIds(bank: QuestionBank) {
  return bank.sections
    .filter((section) => section.isMockExamSection)
    .flatMap((section) => section.problems.map((problem) => problem.id));
}

function isMockRound(bank: QuestionBank, round: QuestionBank["rounds"][number]) {
  const mockIds = new Set(mockProblemIds(bank));
  return round.targetProblemIds.length > 0 && round.targetProblemIds.every((id) => mockIds.has(id));
}

function ProblemList({
  bank, metricColumns, metricLoading, metricError, onReloadMetrics,
  customMetricFilters, setCustomMetricFilters,
  filters, setFilters, selectedProblemIds, setSelectedProblemIds, onStatus, onHistory, onAnswer,
}: {
  bank: QuestionBank;
  metricColumns: CustomMetricColumn[];
  metricLoading: boolean;
  metricError: string;
  customMetricFilters: CustomMetricFilterSelections;
  setCustomMetricFilters: (filters: CustomMetricFilterSelections) => void;
  onReloadMetrics: () => void;
  filters: QuestionFilters;
  setFilters: (filters: QuestionFilters) => void;
  selectedProblemIds: string[];
  setSelectedProblemIds: (ids: string[]) => void;
  onStatus: (ids: string[], status: ProblemReviewStatus) => void;
  onHistory: (id: string) => void;
  onAnswer: (id: string) => void;
}) {
  const pressedAnswerProblemId = useRef("");

  function handleAnswerClick(event: MouseEvent<HTMLButtonElement>, problemId: string) {
    const isKeyboardActivation = event.detail === 0;
    const isPointerActivationStartedHere = pressedAnswerProblemId.current === problemId;
    pressedAnswerProblemId.current = "";
    if (isKeyboardActivation || isPointerActivationStartedHere) onAnswer(problemId);
  }

  function updateFilter<Key extends keyof QuestionFilters>(key: Key, value: QuestionFilters[Key]) {
    setFilters({ ...filters, [key]: value });
  }

  function toggleFilter<Key extends "statuses" | "results" | "confidences">(
    key: Key,
    value: QuestionFilters[Key][number],
  ) {
    const selected = filters[key] as Array<QuestionFilters[Key][number]>;
    updateFilter(
      key,
      (selected.includes(value)
        ? selected.filter((item) => item !== value)
        : [...selected, value]) as QuestionFilters[Key],
    );
  }

  return (
    <div className="problem-list">
      <div className="panel problem-filters">
        <FilterChecks
          label="状態"
          allSelected={filters.statuses.length === 0}
          onAll={() => updateFilter("statuses", [])}
          options={(Object.entries(statusLabels) as Array<[ProblemReviewStatus, string]>).map(([value, label]) => ({
            value,
            label,
            checked: filters.statuses.includes(value),
            onChange: () => toggleFilter("statuses", value),
          }))}
        />
        <CustomMetricFilterControls
          columns={metricColumns}
          selections={customMetricFilters}
          onChange={setCustomMetricFilters}
        />
        <FilterChecks
          label="最新の解答"
          allSelected={filters.results.length === 0}
          onAll={() => updateFilter("results", [])}
          options={[
            ["unanswered", "未解答"],
            ["correct", "正解"],
            ["partial", "部分点"],
            ["incorrect", "不正解"],
          ].map(([value, label]) => ({
            value,
            label,
            checked: filters.results.includes(value as QuestionFilters["results"][number]),
            onChange: () => toggleFilter("results", value as QuestionFilters["results"][number]),
          }))}
        />
        <FilterChecks
          label="確信度"
          allSelected={filters.confidences.length === 0}
          onAll={() => updateFilter("confidences", [])}
          options={[
            ["high", "高"],
            ["medium", "中"],
            ["low", "低"],
            ["unset", "未設定"],
          ].map(([value, label]) => ({
            value,
            label,
            checked: filters.confidences.includes(value as QuestionFilters["confidences"][number]),
            onChange: () => toggleFilter("confidences", value as QuestionFilters["confidences"][number]),
          }))}
        />
        <label>最新日（開始）
          <input type="date" value={filters.latestFrom} onChange={(event) => updateFilter("latestFrom", event.target.value)} />
        </label>
        <label>最新日（終了）
          <input type="date" value={filters.latestTo} onChange={(event) => updateFilter("latestTo", event.target.value)} />
        </label>
        <button type="button" onClick={() => {
          setFilters(initialFilters);
          setCustomMetricFilters({});
        }}>条件をクリア</button>
        <span>{selectedProblemIds.length}問選択</span>
        {(["active", "completed", "paused", "excluded"] as const).map((status) => (
          <button key={status} disabled={!selectedProblemIds.length} onClick={() => onStatus(selectedProblemIds, status)}>
            {statusLabels[status]}へ
          </button>
        ))}
      </div>
      {metricLoading && (
        <div className="metric-column-loading" aria-label="カスタムメトリクスを読み込んでいます">
          <span /><span /><span />
        </div>
      )}
      {!metricLoading && metricError && (
        <div className="custom-metric-error metric-column-error" role="alert">
          <p>カスタムメトリクスを取得できませんでした: {metricError}</p>
          <button type="button" onClick={onReloadMetrics}>再読み込み</button>
        </div>
      )}
      {bank.sections.map((section) => {
        const visible = section.problems.filter((problem) => (
          matchesFilter(problem, filters)
          && (
            metricLoading
            || Boolean(metricError)
            || matchesCustomMetricFilters(problem.id, metricColumns, customMetricFilters)
          )
        ));
        const sectionProblemIds = section.problems.map((problem) => problem.id);
        return (
          <details className="panel question-section" key={section.id} open>
            <summary>
              <span><strong>{section.title}</strong> <small>{section.evaluationType === "binary" ? "正誤" : section.evaluationType === "partial_score" ? "部分点" : "混在"}{section.isMockExamSection ? "・模擬試験" : ""}</small></span>
              <span className="section-summary-actions">
                <span>{visible.length}/{section.problems.length}問</span>
              </span>
            </summary>
            <div className="problem-table-wrap">
              <table className="problem-table">
                <thead><tr>
                  <th>選択</th>
                  <th>問題</th>
                  <th>解答履歴 <small className="confidence-legend">確信度 ●●● / ●● / ●</small></th>
                  <th>最新日</th>
                  <th>状態</th>
                  {metricColumns.map((column) => (
                    <CustomMetricHeader
                      key={column.metricId}
                      column={column}
                      problemIds={sectionProblemIds}
                      scopeLabel={section.title}
                    />
                  ))}
                  <th>操作</th>
                </tr></thead>
                <tbody>
                  {visible.map((problem) => {
                    const attempt = latestAttempt(problem);
                    return (
                      <tr key={problem.id}>
                        <td><input type="checkbox" aria-label={`No.${problem.number}を選択`} checked={selectedProblemIds.includes(problem.id)} onChange={(event) => setSelectedProblemIds(event.target.checked ? [...selectedProblemIds, problem.id] : selectedProblemIds.filter((id) => id !== problem.id))} /></td>
                        <td><strong>No.{problem.number}</strong>{problem.title && <small>{problem.title}</small>}</td>
                        <td>
                          <PracticeRoundHistoryMarks bank={bank} problem={problem} />
                        </td>
                        <td>{attempt ? formatAttemptDay(attempt.answeredAt) : "—"}</td>
                        <td>
                          <select value={problem.reviewStatus} onChange={(event) => onStatus([problem.id], event.target.value as ProblemReviewStatus)}>
                            {Object.entries(statusLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                          </select>
                        </td>
                        {metricColumns.map((column) => (
                          <CustomMetricCell
                            key={column.metricId}
                            column={column}
                            problemId={problem.id}
                          />
                        ))}
                        <td>
                          <button
                            type="button"
                            onPointerDown={() => { pressedAnswerProblemId.current = problem.id; }}
                            onPointerCancel={() => { pressedAnswerProblemId.current = ""; }}
                            onClick={(event) => handleAnswerClick(event, problem.id)}
                          >
                            解答
                          </button>
                          <button onClick={() => onHistory(problem.id)}>履歴</button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </details>
        );
      })}
    </div>
  );
}

export function CustomMetricHeader({
  column,
  problemIds,
  scopeLabel,
}: {
  column: CustomMetricColumn;
  problemIds?: Iterable<string>;
  scopeLabel?: string;
}) {
  const scopedProblemIds = problemIds ? [...problemIds] : undefined;
  const progress = getCustomMetricProgress(column, scopedProblemIds);
  return (
    <th
      className="custom-metric-column-header"
      title={customMetricTooltip(column, scopedProblemIds, scopeLabel)}
    >
      {column.icon && <span aria-hidden="true">{column.icon}</span>}
      <small>{column.name}</small>
      <strong>{formatCustomMetricProgress(progress)}</strong>
    </th>
  );
}

export function CustomMetricOverallSummary({
  columns,
  loading,
}: {
  columns: CustomMetricColumn[];
  loading: boolean;
}) {
  if (loading || columns.length === 0) return null;
  return (
    <section className="panel custom-metric-overall-summary">
      <div>
        <span className="eyebrow">教材全体</span>
        <h2>カスタムメトリクス</h2>
      </div>
      <div className="custom-metric-overall-grid">
        {columns.map((column) => {
          const progress = getCustomMetricProgress(column);
          return (
            <div
              className="custom-metric-overall-card"
              key={column.metricId}
              title={customMetricTooltip(column, undefined, "教材全体")}
            >
              <span aria-hidden="true">{column.icon}</span>
              <small>{column.name}</small>
              <strong>{formatCustomMetricProgress(progress)}</strong>
            </div>
          );
        })}
      </div>
    </section>
  );
}

export function CustomMetricCell({
  column,
  problemId,
}: {
  column: CustomMetricColumn;
  problemId: string;
}) {
  const state = getCustomMetricCellState(column, problemId);
  const labels = {
    outside_population: `${column.name}: 集計対象外`,
    matched: `${column.name}: 達成`,
    unmatched: `${column.name}: 未達成`,
  };
  return (
    <td
      className={`custom-metric-cell ${state}`}
      aria-label={labels[state]}
    >{customMetricCellText(state)}</td>
  );
}

function FilterChecks({
  label,
  allSelected,
  onAll,
  options,
}: {
  label: string;
  allSelected: boolean;
  onAll: () => void;
  options: Array<{ value: string; label: string; checked: boolean; onChange: () => void }>;
}) {
  return (
    <fieldset className="filter-checks">
      <legend>{label}</legend>
      <label><input type="checkbox" checked={allSelected} onChange={onAll} />すべて</label>
      {options.map((option) => (
        <label key={option.value}>
          <input type="checkbox" checked={option.checked} onChange={option.onChange} />
          {option.label}
        </label>
      ))}
    </fieldset>
  );
}

export function CustomMetricFilterControls({
  columns,
  selections,
  onChange,
}: {
  columns: CustomMetricColumn[];
  selections: CustomMetricFilterSelections;
  onChange: (selections: CustomMetricFilterSelections) => void;
}) {
  if (columns.length === 0) return null;
  const labels: Record<CustomMetricFilterMode, string> = {
    matched: "達成",
    unmatched: "未達",
  };
  return (
    <fieldset className="filter-checks custom-metric-filter-controls">
      <legend>カスタムメトリクス</legend>
      {columns.map((column) => {
        const mode = selections[column.metricId];
        return (
          <div key={column.metricId}>
            <label>
              <span aria-hidden="true">{column.icon}</span>
              {column.name}
            </label>
            <select
              aria-label={`${column.name}の絞り込み状態`}
              value={mode ?? ""}
              onChange={(event) => {
                if (event.target.value === "") {
                  const next = { ...selections };
                  delete next[column.metricId];
                  onChange(next);
                } else {
                  onChange({
                    ...selections,
                    [column.metricId]: event.target.value as CustomMetricFilterMode,
                  });
                }
              }}
            >
              <option value="">未指定</option>
              {(Object.entries(labels) as Array<[CustomMetricFilterMode, string]>)
                .map(([value, label]) => (
                  <option key={value} value={value}>{label}</option>
                ))}
            </select>
          </div>
        );
      })}
    </fieldset>
  );
}

export function AnswerPanel({
  bank,
  problem,
  roundId,
  onClose,
  onSaved,
}: {
  bank: QuestionBank;
  problem: Problem;
  roundId: string;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const section = bank.sections.find((item) => item.id === problem.sectionId)!;
  const binary = problem.evaluationTypeOverride === "binary" || (!problem.evaluationTypeOverride && section.evaluationType === "binary");
  const [earnedScore, setEarnedScore] = useState(problem.defaultMaxScore);
  const [maxScore, setMaxScore] = useState(problem.defaultMaxScore);
  const [confidence, setConfidence] = useState<Confidence>(null);
  const [note, setNote] = useState("");
  const [selectedRoundId, setSelectedRoundId] = useState(roundId);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    setEarnedScore(problem.defaultMaxScore);
    setMaxScore(problem.defaultMaxScore);
    setConfidence(null);
    setNote("");
    setSelectedRoundId(roundId);
  }, [problem.id, problem.defaultMaxScore, roundId]);
  async function submit(event?: FormEvent) {
    event?.preventDefault();
    if (saving) return;
    try {
      setError("");
      setSaving(true);
      await service.recordAttempt({
        problemId: problem.id,
        roundId: selectedRoundId,
        earnedScore,
        maxScore,
        confidence,
        note,
      });
      await onSaved();
    } catch (cause) {
      setError(toMessage(cause));
    } finally {
      setSaving(false);
    }
  }
  return (
    <form className="modal-panel answer-panel" onSubmit={submit}>
      <button className="dialog-close" type="button" onClick={onClose}>閉じる</button>
      <span className="eyebrow">{bank.title}・{section.title}</span>
      <h2>No.{problem.number} 解答履歴を登録</h2>
      <PracticeRoundHistoryMarks bank={bank} problem={problem} />
      <label>周回
        <select
          value={selectedRoundId}
          onChange={(event) => setSelectedRoundId(event.target.value)}
          required
        >
          {[...bank.rounds]
            .sort((left, right) => left.roundNumber - right.roundNumber)
            .filter((round) => (
              round.id === selectedRoundId
              || !problem.attempts.some((attempt) => attempt.roundId === round.id)
            ))
            .map((round) => (
              <option key={round.id} value={round.id}>{round.roundNumber}周目</option>
            ))}
        </select>
      </label>
      {binary && (
        <div className="binary-buttons">
          <button type="button" className={earnedScore === 1 && maxScore === 1 ? "selected" : ""} onClick={() => { setEarnedScore(1); setMaxScore(1); }}>○ 正解 1/1</button>
          <button type="button" className={earnedScore === 0 && maxScore === 1 ? "selected" : ""} onClick={() => { setEarnedScore(0); setMaxScore(1); }}>× 不正解 0/1</button>
        </div>
      )}
      <div className="score-fields">
        <label>得点<input autoFocus type="number" min="0" step="0.001" value={earnedScore} onChange={(event) => setEarnedScore(event.target.valueAsNumber)} /></label>
        <span>/</span>
        <label>満点<input type="number" min="1" step="0.001" value={maxScore} onChange={(event) => setMaxScore(event.target.valueAsNumber)} /></label>
      </div>
      <Segmented label="確信度" options={[["high", "高"], ["medium", "中"], ["low", "低"], ["", "未設定"]]} value={confidence ?? ""} onChange={(value) => setConfidence((value || null) as Confidence)} />
      <label>メモ（任意）<textarea value={note} onChange={(event) => setNote(event.target.value)} rows={3} /></label>
      {error && <p className="form-error">{error}</p>}
      <button className="primary-button" disabled={saving}>{saving ? "保存中…" : "解答履歴を保存"}</button>
    </form>
  );
}

function Segmented({ label, options, value, onChange }: { label: string; options: Array<[string, string]>; value: string; onChange: (value: string) => void }) {
  return <fieldset className="segmented"><legend>{label}</legend>{options.map(([id, text]) => <button type="button" className={value === id ? "selected" : ""} key={id} onClick={() => onChange(id)}>{text}</button>)}</fieldset>;
}

export function ModalBackdrop({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  return (
    <div className="history-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      {children}
    </div>
  );
}

export function ProblemEditPanel({
  bank,
  problem,
  onCancel,
  onSave,
}: {
  bank: QuestionBank;
  problem: Problem;
  onCancel: () => void;
  onSave: (input: {
    number: string;
    title?: string;
    sectionId: string;
    evaluationTypeOverride?: "binary" | "partial_score";
    defaultMaxScore: number;
    supplementalInfo?: string;
  }) => Promise<void>;
}) {
  const [number, setNumber] = useState(problem.number);
  const [title, setTitle] = useState(problem.title ?? "");
  const [sectionId, setSectionId] = useState(problem.sectionId);
  const [format, setFormat] = useState(problem.evaluationTypeOverride ?? "");
  const [maxScore, setMaxScore] = useState(problem.defaultMaxScore);
  const [supplementalInfo, setSupplementalInfo] = useState(problem.supplementalInfo ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  return (
    <form className="modal-panel problem-edit-panel" onSubmit={async (event) => {
      event.preventDefault();
      if (saving) return;
      try {
        setSaving(true);
        setError("");
        await onSave({
          number,
          title,
          sectionId,
          evaluationTypeOverride: (format || undefined) as "binary" | "partial_score" | undefined,
          defaultMaxScore: maxScore,
          supplementalInfo,
        });
      } catch (cause) {
        setError(toMessage(cause));
      } finally {
        setSaving(false);
      }
    }}>
      <button className="dialog-close" type="button" onClick={onCancel}>閉じる</button>
      <h2>No.{problem.number}を編集</h2>
      <label>問題番号<input value={number} onChange={(event) => setNumber(event.target.value)} required /></label>
      <label>問題名<input value={title} onChange={(event) => setTitle(event.target.value)} /></label>
      <label>問題形式
        <select value={format} onChange={(event) => setFormat(event.target.value)}>
          <option value="">大問の設定を使用</option>
          <option value="binary">正誤</option>
          <option value="partial_score">部分点</option>
        </select>
      </label>
      <label>配点<input type="number" min="1" step="0.001" value={maxScore} onChange={(event) => setMaxScore(event.target.valueAsNumber)} required /></label>
      <label>所属セクション
        <select value={sectionId} onChange={(event) => setSectionId(event.target.value)}>
          {bank.sections.map((section) => <option key={section.id} value={section.id}>{section.title}</option>)}
        </select>
      </label>
      <label>補足情報<textarea rows={4} value={supplementalInfo} onChange={(event) => setSupplementalInfo(event.target.value)} /></label>
      {error && <p className="form-error">{error}</p>}
      <div className="modal-actions">
        <button type="button" onClick={onCancel}>キャンセル</button>
        <button className="primary-button" disabled={saving}>{saving ? "保存中…" : "変更を保存"}</button>
      </div>
    </form>
  );
}

export function DeleteProblemPanel({
  problem,
  onCancel,
  onDelete,
}: {
  problem: Problem;
  onCancel: () => void;
  onDelete: () => Promise<void>;
}) {
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState("");
  return (
    <section className="modal-panel delete-problem-panel" role="alertdialog" aria-modal="true">
      <h2>No.{problem.number}を削除しますか？</h2>
      <p>この操作は取り消せません。</p>
      {problem.attempts.length > 0 && (
        <p className="delete-warning">関連する解答履歴 {problem.attempts.length}件もSQLiteから削除されます。</p>
      )}
      {error && <p className="form-error">{error}</p>}
      <div className="modal-actions">
        <button onClick={onCancel}>キャンセル</button>
        <button className="danger-button" disabled={deleting} onClick={async () => {
          if (deleting) return;
          try {
            setDeleting(true);
            setError("");
            await onDelete();
          } catch (cause) {
            setError(toMessage(cause));
            setDeleting(false);
          }
        }}>{deleting ? "削除中…" : "削除する"}</button>
      </div>
    </section>
  );
}

export function HistoryPanel({
  problem,
  bank,
  onClose,
  onChanged,
  onAdd,
}: {
  problem: Problem;
  bank: QuestionBank;
  onClose: () => void;
  onChanged: () => Promise<void>;
  onAdd: (roundId: string) => void;
}) {
  const [editing, setEditing] = useState<ProblemAttempt | null>(null);
  const [deletingAttemptId, setDeletingAttemptId] = useState("");
  const roundHistory = getPracticeRoundHistory(bank, problem);
  async function remove(id: string) {
    await service.deleteAttempt(id);
    setDeletingAttemptId("");
    await onChanged();
  }
  return (
    <div className="history-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="history-dialog" role="dialog" aria-modal="true" aria-label={`問題No.${problem.number}の履歴`}>
        <button className="dialog-close" onClick={onClose}>閉じる</button>
        <h2>問題 No.{problem.number}</h2>
        <p>配点: {problem.defaultMaxScore}点・現在の状態: {statusLabels[problem.reviewStatus]}</p>
        {roundHistory.length === 0 && <p>周回履歴はありません。</p>}
        {roundHistory.map((entry) => {
          const attempt = entry.attempt;
          if (!attempt) {
            return (
              <div className="history-entry history-entry-missing" key={entry.roundId}>
                <strong>{entry.roundNumber}周目</strong>
                <span>-</span>
                <div className="history-entry-actions">
                  <button onClick={() => onAdd(entry.roundId)}>解答を追加</button>
                </div>
              </div>
            );
          }
          return (
            <div className="history-entry" key={entry.roundId}>
              <strong>{entry.roundNumber}周目</strong>
              <dl>
                <div><dt>日時</dt><dd>{formatAttemptDate(attempt.answeredAt)}</dd></div>
                <div><dt>得点</dt><dd>{scoreMark(deriveScoreResult(attempt.earnedScore, attempt.maxScore))} {attempt.earnedScore} / {attempt.maxScore}</dd></div>
                <div><dt>得点率</dt><dd>{((attempt.earnedScore / attempt.maxScore) * 100).toFixed(1)}%</dd></div>
                <div><dt>確信度</dt><dd>{attempt.confidence ? confidenceLabels[attempt.confidence] : "未設定"}</dd></div>
                <div><dt>メモ</dt><dd>{attempt.note || "—"}</dd></div>
              </dl>
              <div className="history-entry-actions">
                <button onClick={() => setEditing(attempt)}>編集</button>
                {deletingAttemptId === attempt.id ? (
                  <>
                    <span>本当に削除しますか？</span>
                    <button className="danger-button" onClick={() => void remove(attempt.id)}>削除する</button>
                    <button onClick={() => setDeletingAttemptId("")}>戻る</button>
                  </>
                ) : (
                  <button onClick={() => setDeletingAttemptId(attempt.id)}>削除</button>
                )}
              </div>
            </div>
          );
        })}
        {editing && <AttemptEditForm attempt={editing} onCancel={() => setEditing(null)} onSaved={async () => { setEditing(null); await onChanged(); }} />}
      </section>
    </div>
  );
}

function AttemptEditForm({ attempt, onCancel, onSaved }: { attempt: ProblemAttempt; onCancel: () => void; onSaved: () => Promise<void> }) {
  const [answeredAt, setAnsweredAt] = useState(toDateTimeLocalValue(attempt.answeredAt));
  const [earned, setEarned] = useState(attempt.earnedScore);
  const [max, setMax] = useState(attempt.maxScore);
  const [confidence, setConfidence] = useState<Confidence>(attempt.confidence);
  const [note, setNote] = useState(attempt.note ?? "");
  return (
    <form className="attempt-edit" onSubmit={async (event) => {
      event.preventDefault();
      await service.updateAttempt(attempt.id, {
        ...attempt,
        answeredAt: new Date(answeredAt).toISOString(),
        earnedScore: earned,
        maxScore: max,
        confidence,
        note,
      });
      await onSaved();
    }}>
      <label>日時<input type="datetime-local" required value={answeredAt} onChange={(event) => setAnsweredAt(event.target.value)} /></label>
      <label>獲得点<input type="number" min="0" step="0.001" value={earned} onChange={(event) => setEarned(event.target.valueAsNumber)} /></label>
      <label>満点<input type="number" min="1" step="0.001" value={max} onChange={(event) => setMax(event.target.valueAsNumber)} /></label>
      <select value={confidence ?? ""} onChange={(event) => setConfidence((event.target.value || null) as Confidence)}><option value="">未設定</option><option value="high">高</option><option value="medium">中</option><option value="low">低</option></select>
      <input value={note} onChange={(event) => setNote(event.target.value)} placeholder="メモ" />
      <button>更新</button><button type="button" onClick={onCancel}>キャンセル</button>
    </form>
  );
}

function ScoreMark({ result }: { result?: ReturnType<typeof deriveScoreResult> }) {
  return <span className={`score-mark ${result ?? "none"}`}>{result ? scoreMark(result) : "—"}</span>;
}

export function PracticeRoundHistoryMarks({
  bank,
  problem,
}: {
  bank: QuestionBank;
  problem: Problem;
}) {
  const roundHistory = getPracticeRoundHistory(bank, problem);
  return (
    <div className="score-mark-history" aria-label={`${roundHistory.length}周分の解答履歴`}>
      {roundHistory.length
        ? roundHistory.map((entry) => (
            entry.attempt ? (
              <HistoryScoreMark
                key={entry.roundId}
                attempt={entry.attempt}
                roundNumber={entry.roundNumber}
              />
            ) : (
              <span
                className="history-score history-score-missing"
                key={entry.roundId}
                aria-label={`${entry.roundNumber}周目、解答履歴なし`}
              >
                <span className="score-mark none">-</span>
              </span>
            )
          ))
        : <ScoreMark />}
    </div>
  );
}

function HistoryScoreMark({
  attempt,
  roundNumber,
}: {
  attempt: ProblemAttempt;
  roundNumber: number;
}) {
  const result = deriveScoreResult(attempt.earnedScore, attempt.maxScore);
  const confidence = attempt.confidence ? confidenceLabels[attempt.confidence] : "未設定";
  const [tooltipPosition, setTooltipPosition] = useState<{ left: number; top: number; below: boolean } | null>(null);
  const tooltipId = `history-tooltip-${attempt.id}`;

  function showTooltip(target: HTMLElement) {
    const rect = target.getBoundingClientRect();
    const below = rect.top < 180;
    setTooltipPosition({
      left: Math.min(Math.max(rect.left + rect.width / 2, 160), window.innerWidth - 160),
      top: below ? rect.bottom + 10 : rect.top - 10,
      below,
    });
  }

  return (
    <span
      className={`history-score result-${result} confidence-${attempt.confidence ?? "unset"}`}
      tabIndex={0}
      aria-label={`${roundNumber}周目、${scoreMark(result)}、確信度${confidence}`}
      aria-describedby={tooltipPosition ? tooltipId : undefined}
      onMouseEnter={(event) => showTooltip(event.currentTarget)}
      onMouseLeave={() => setTooltipPosition(null)}
      onFocus={(event) => showTooltip(event.currentTarget)}
      onBlur={() => setTooltipPosition(null)}
    >
      <ScoreMark result={result} />
      <ConfidenceIndicator confidence={attempt.confidence} />
      {tooltipPosition && createPortal(
        <span
          id={tooltipId}
          className={`history-score-tooltip ${tooltipPosition.below ? "below" : "above"}`}
          role="tooltip"
          style={{ left: tooltipPosition.left, top: tooltipPosition.top }}
        >
          <strong>{roundNumber}周目</strong>
          <span>日時: {formatAttemptDate(attempt.answeredAt)}</span>
          <span>得点: {attempt.earnedScore} / {attempt.maxScore}</span>
          <span>確信度: {confidence}</span>
          <span>メモ: {attempt.note || "—"}</span>
        </span>,
        document.body,
      )}
    </span>
  );
}

function ConfidenceIndicator({ confidence }: { confidence: Confidence }) {
  const filled = confidence === "high" ? 3 : confidence === "medium" ? 2 : confidence === "low" ? 1 : 0;
  return (
    <span className="confidence-indicator" aria-hidden="true">
      {Array.from({ length: filled }, (_, index) => <i key={index} />)}
    </span>
  );
}

function scoreMark(result: ReturnType<typeof deriveScoreResult>) {
  return result === "correct" ? "○" : result === "partial" ? "△" : "×";
}

function toDateTimeLocalValue(value: string | null) {
  if (!value) return "";
  const date = new Date(value);
  const localDate = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return localDate.toISOString().slice(0, 16);
}

export function toMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
