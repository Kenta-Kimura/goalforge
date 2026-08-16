import React, { FormEvent, MouseEvent, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { isTauriRuntime } from "../lib/tauri";
import type { Goal, StudyPlan } from "../types";
import {
  calculateBankSummary,
  calculateContentLabelSummaries,
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
import { downloadLearningHistoryCsv, downloadLearningHistoryJson } from "./learningHistoryExport";
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

export function ExerciseView({ goal, studyPlan }: { goal: Goal; studyPlan?: StudyPlan }) {
  const [banks, setBanks] = useState<QuestionBank[]>([]);
  const [selectedBankId, setSelectedBankId] = useState("");
  const [filters, setFilters] = useState<QuestionFilters>(initialFilters);
  const [selectedProblemIds, setSelectedProblemIds] = useState<string[]>([]);
  const [activeMockRoundId, setActiveMockRoundId] = useState("");
  const [answerRequest, setAnswerRequest] = useState<{
    problemId: string;
    roundId: string;
    followingProblemIds: string[];
  } | null>(null);
  const [historyProblemId, setHistoryProblemId] = useState("");
  const [historyEditAttemptId, setHistoryEditAttemptId] = useState("");
  const historyScrollPosition = useRef<{ left: number; top: number } | null>(null);
  const historyBodyStyle = useRef<{
    position: string;
    top: string;
    left: string;
    right: string;
    width: string;
  } | null>(null);
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

  function openHistory(problemId: string, attemptId = "") {
    const position = { left: window.scrollX, top: window.scrollY };
    historyScrollPosition.current = position;
    if (!historyBodyStyle.current) {
      historyBodyStyle.current = {
        position: document.body.style.position,
        top: document.body.style.top,
        left: document.body.style.left,
        right: document.body.style.right,
        width: document.body.style.width,
      };
      document.body.style.position = "fixed";
      document.body.style.top = `${-position.top}px`;
      document.body.style.left = `${-position.left}px`;
      document.body.style.right = "0";
      document.body.style.width = "100%";
    }
    setHistoryEditAttemptId(attemptId);
    setHistoryProblemId(problemId);
  }

  function closeHistory(_restoreScroll = true) {
    const position = historyScrollPosition.current;
    const bodyStyle = historyBodyStyle.current;
    setHistoryProblemId("");
    setHistoryEditAttemptId("");
    if (!position || !bodyStyle) return;
    requestAnimationFrame(() => {
      document.body.style.position = bodyStyle.position;
      document.body.style.top = bodyStyle.top;
      document.body.style.left = bodyStyle.left;
      document.body.style.right = bodyStyle.right;
      document.body.style.width = bodyStyle.width;
      window.scrollTo(position.left, position.top);
      requestAnimationFrame(() => {
        window.scrollTo(position.left, position.top);
        historyScrollPosition.current = null;
        historyBodyStyle.current = null;
      });
    });
  }

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
            <button type="button" disabled={!bank} onClick={() => {
              if (!bank) return;
              try {
                downloadLearningHistoryJson(bank, goal, studyPlan);
                setMessage("ChatGPT分析用の学習履歴JSONをファイルへ出力しました。");
              } catch (error) {
                setMessage(`学習履歴をエクスポートできませんでした: ${toMessage(error)}`);
              }
            }}>JSONを出力</button>
            <button type="button" disabled={!bank} onClick={() => {
              if (!bank) return;
              try {
                downloadLearningHistoryCsv(bank, goal, studyPlan);
                setMessage("学習履歴CSVをファイルへ出力しました。");
              } catch (error) {
                setMessage(`学習履歴をエクスポートできませんでした: ${toMessage(error)}`);
              }
            }}>CSVを出力</button>
          </div>
          {bank && (
            <>
              <BankSummary bank={bank} />
              <LearningRoundSummary bank={bank} />
              <ContentLabelSummaryPanel bank={bank} />
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
                onHistory={(problemId) => openHistory(problemId)}
                onEditAttempt={(problemId, attemptId) => openHistory(problemId, attemptId)}
                onAnswer={async (problemId, followingProblemIds) => {
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
                  setAnswerRequest({ problemId, roundId: round.id, followingProblemIds });
                }}
              />
              {answerRequest && answerProblem && (
                <ModalBackdrop onClose={() => setAnswerRequest(null)}>
                  <AnswerPanel
                    bank={bank}
                    problem={answerProblem}
                    roundId={answerRequest.roundId}
                    onClose={() => setAnswerRequest(null)}
                    onSaved={async (savedRoundId) => {
                      await refresh();
                      const nextProblemId = findNextUnansweredProblemId(
                        answerRequest.followingProblemIds,
                        problems,
                        savedRoundId,
                      );
                      const nextIndex = nextProblemId
                        ? answerRequest.followingProblemIds.indexOf(nextProblemId)
                        : -1;
                      if (nextIndex >= 0) {
                        setAnswerRequest({
                          problemId: nextProblemId!,
                          roundId: savedRoundId,
                          followingProblemIds: answerRequest.followingProblemIds.slice(nextIndex + 1),
                        });
                        setMessage("解答を保存しました。次の問題へ進みます。");
                      } else {
                        setAnswerRequest(null);
                        setMessage("解答を保存しました。このセクションの最後の問題です。");
                      }
                    }}
                  />
                </ModalBackdrop>
              )}
              {historyProblem && (
                <HistoryPanel
                  problem={historyProblem}
                  bank={bank}
                  initialEditingAttemptId={historyEditAttemptId}
                  onClose={() => closeHistory()}
                  onChanged={refresh}
                  onAdd={(roundId) => {
                    closeHistory(false);
                    setAnswerRequest({ problemId: historyProblem.id, roundId, followingProblemIds: [] });
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

export function findNextUnansweredProblemId(
  followingProblemIds: string[],
  problems: Problem[],
  roundId: string,
) {
  return followingProblemIds.find((problemId) => {
    const problem = problems.find((item) => item.id === problemId);
    return problem && !problem.attempts.some((attempt) => attempt.roundId === roundId);
  });
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

export function ContentLabelSummaryPanel({ bank }: { bank: QuestionBank }) {
  const sections = calculateContentLabelSummaries(bank);
  if (sections.length === 0) return null;
  return (
    <details className="panel content-label-summary">
      <summary>
        <div>
        <span className="eyebrow">各問題の最新解答</span>
        <h2>セクション別・内容ラベル別集計</h2>
        </div>
        <span className="content-label-summary-toggle" aria-hidden="true">展開</span>
      </summary>
      <div className="content-label-summary-body">
        {sections.map((section) => (
          <div className="content-label-section" key={section.sectionId}>
            <div className="content-label-section-heading">
              <h3>{section.sectionTitle}</h3>
              <div>
                <span>解答 {section.summary.answered}/{section.summary.total}</span>
                <span>正答率 {section.summary.accuracyRate === null ? "—" : `${(section.summary.accuracyRate * 100).toFixed(1)}%`}</span>
                <span>○ / △ / × {section.summary.correct} / {section.summary.partial} / {section.summary.incorrect}</span>
                <span>得点率 {section.summary.scoreRate === null ? "—" : `${section.summary.earnedScore}/${section.summary.maxScore}点 (${(section.summary.scoreRate * 100).toFixed(1)}%)`}</span>
              </div>
            </div>
            <div className="content-label-summary-table-wrap">
              <table className="content-label-summary-table">
                <thead>
                  <tr>
                    <th>内容ラベル</th>
                    <th>解答進捗</th>
                    <th>正答率</th>
                    <th>○ / △ / ×</th>
                    <th>得点率</th>
                  </tr>
                </thead>
                <tbody>
                  {section.labels.map((summary) => (
                    <tr key={summary.label}>
                      <th scope="row">{summary.label}</th>
                      <td>{summary.answered}/{summary.total}</td>
                      <td>{summary.accuracyRate === null ? "—" : `${(summary.accuracyRate * 100).toFixed(1)}%`}</td>
                      <td>{summary.correct} / {summary.partial} / {summary.incorrect}</td>
                      <td>
                        {summary.scoreRate === null
                          ? "—"
                          : `${summary.earnedScore}/${summary.maxScore}点 (${(summary.scoreRate * 100).toFixed(1)}%)`}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ))}
      </div>
    </details>
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

export function ProblemList({
  bank, metricColumns, metricLoading, metricError, onReloadMetrics,
  customMetricFilters, setCustomMetricFilters,
  filters, setFilters, selectedProblemIds, setSelectedProblemIds, onStatus, onHistory, onAnswer,
  onEditAttempt,
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
  onEditAttempt?: (problemId: string, attemptId: string) => void;
  onAnswer: (id: string, followingProblemIds: string[]) => void;
}) {
  const pressedAnswerProblemId = useRef("");
  const [activeSectionId, setActiveSectionId] = useState(bank.sections[0]?.id ?? "");
  const [collapsedContentLabels, setCollapsedContentLabels] = useState<Set<string>>(() => new Set());
  const sectionViews = bank.sections.map((section) => ({
    section,
    visibleProblems: section.problems.filter((problem) => (
      matchesFilter(problem, filters)
      && (
        metricLoading
        || Boolean(metricError)
        || matchesCustomMetricFilters(problem.id, metricColumns, customMetricFilters)
      )
    )),
  }));
  const activeSectionView = sectionViews.find(({ section }) => section.id === activeSectionId) ?? sectionViews[0];

  useEffect(() => {
    setActiveSectionId((current) => (
      bank.sections.some((section) => section.id === current)
        ? current
        : bank.sections[0]?.id ?? ""
    ));
  }, [bank.id, bank.sections]);

  function handleAnswerClick(
    event: MouseEvent<HTMLButtonElement>,
    problemId: string,
    followingProblemIds: string[],
  ) {
    const isKeyboardActivation = event.detail === 0;
    const isPointerActivationStartedHere = pressedAnswerProblemId.current === problemId;
    pressedAnswerProblemId.current = "";
    if (isKeyboardActivation || isPointerActivationStartedHere) onAnswer(problemId, followingProblemIds);
  }

  function updateFilter<Key extends keyof QuestionFilters>(key: Key, value: QuestionFilters[Key]) {
    setFilters({ ...filters, [key]: value });
  }

  function toggleContentLabel(sectionId: string, label: string) {
    const key = `${sectionId}\u0000${label}`;
    setCollapsedContentLabels((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
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
      {sectionViews.length > 0 && (
        <div className="question-section-tabs" role="tablist" aria-label="問題セクション">
          {sectionViews.map(({ section, visibleProblems }) => (
            <button
              key={section.id}
              type="button"
              role="tab"
              aria-selected={section.id === activeSectionView?.section.id}
              aria-controls={`question-section-${section.id}`}
              className={section.id === activeSectionView?.section.id ? "selected" : ""}
              onClick={() => setActiveSectionId(section.id)}
            >
              <strong>{section.title}</strong>
              <small>{visibleProblems.length}/{section.problems.length}問</small>
            </button>
          ))}
        </div>
      )}
      {activeSectionView && (() => {
        const { section, visibleProblems: visible } = activeSectionView;
        const sectionProblemIds = section.problems.map((problem) => problem.id);
        const contentLabelGroups = groupProblemsByContentLabel(visible);
        const orderedVisibleProblems = contentLabelGroups.flatMap((group) => group.problems);
        const followingProblemIdsById = new Map(orderedVisibleProblems.map((problem, index) => [
          problem.id,
          orderedVisibleProblems.slice(index + 1).map((item) => item.id),
        ]));
        return (
          <section
            className="panel question-section"
            key={section.id}
            id={`question-section-${section.id}`}
            role="tabpanel"
          >
            <header className="question-section-heading">
              <span><strong>{section.title}</strong> <small>{section.evaluationType === "binary" ? "正誤" : section.evaluationType === "partial_score" ? "部分点" : "混在"}{section.isMockExamSection ? "・模擬試験" : ""}</small></span>
              <span className="section-summary-actions">
                <span>{visible.length}/{section.problems.length}問</span>
              </span>
            </header>
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
                  {contentLabelGroups.map((group) => {
                    const groupKey = `${section.id}\u0000${group.label}`;
                    const collapsed = collapsedContentLabels.has(groupKey);
                    return (
                      <React.Fragment key={groupKey}>
                        <tr className="content-label-group-row">
                          <th colSpan={6 + metricColumns.length}>
                            <button
                              type="button"
                              aria-expanded={!collapsed}
                              onClick={() => toggleContentLabel(section.id, group.label)}
                            >
                              <span>{group.label || "内容ラベルなし"}</span>
                              <small>{group.problems.length}問・{collapsed ? "展開" : "閉じる"}</small>
                            </button>
                          </th>
                        </tr>
                        {!collapsed && group.problems.map((problem) => {
                          const attempt = latestAttempt(problem);
                          return (
                            <tr key={problem.id}>
                        <td><input type="checkbox" aria-label={`${problem.number}を選択`} checked={selectedProblemIds.includes(problem.id)} onChange={(event) => setSelectedProblemIds(event.target.checked ? [...selectedProblemIds, problem.id] : selectedProblemIds.filter((id) => id !== problem.id))} /></td>
                        <td><strong>{problem.number}</strong>{problem.title && <small>{problem.title}</small>}</td>
                        <td>
                          <PracticeRoundHistoryMarks
                            bank={bank}
                            problem={problem}
                            onEditAttempt={onEditAttempt
                              ? (attemptId) => onEditAttempt(problem.id, attemptId)
                              : undefined}
                          />
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
                            onClick={(event) => handleAnswerClick(
                              event,
                              problem.id,
                              followingProblemIdsById.get(problem.id) ?? [],
                            )}
                          >
                            解答
                          </button>
                          <button onClick={() => onHistory(problem.id)}>履歴</button>
                        </td>
                      </tr>
                          );
                        })}
                      </React.Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>
        );
      })()}
    </div>
  );
}

export interface ContentLabelProblemGroup {
  label: string;
  problems: Problem[];
}

export function groupProblemsByContentLabel(problems: Problem[]): ContentLabelProblemGroup[] {
  const groups = new Map<string, Problem[]>();
  for (const problem of problems) {
    const label = problem.title?.trim() ?? "";
    groups.set(label, [...(groups.get(label) ?? []), problem]);
  }
  return [...groups.entries()].map(([label, groupedProblems]) => ({
    label,
    problems: groupedProblems,
  }));
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
  onSaved: (savedRoundId: string) => Promise<void>;
}) {
  const section = bank.sections.find((item) => item.id === problem.sectionId)!;
  const binary = problem.evaluationTypeOverride === "binary" || (!problem.evaluationTypeOverride && section.evaluationType === "binary");
  const [earnedScore, setEarnedScore] = useState(problem.defaultMaxScore);
  const [maxScore, setMaxScore] = useState(problem.defaultMaxScore);
  const [confidence, setConfidence] = useState<Confidence>(null);
  const [note, setNote] = useState("");
  const [userAnswer, setUserAnswer] = useState("");
  const [selectedRoundId, setSelectedRoundId] = useState(roundId);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    setEarnedScore(problem.defaultMaxScore);
    setMaxScore(problem.defaultMaxScore);
    setConfidence(null);
    setNote("");
    setUserAnswer("");
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
        userAnswer,
        correctAnswer: problem.correctAnswer,
      });
      await onSaved(selectedRoundId);
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
      <h2>{problem.number} 解答履歴を登録</h2>
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
        <div className="answer-text-fields">
          <label>自分の解答
            <input autoFocus value={userAnswer} onChange={(event) => {
              setUserAnswer(event.target.value);
            }} placeholder="例: A、③、○" />
          </label>
          {problem.correctAnswer?.trim() ? (
            <p className="helper-text">保存後に正誤と得点を自動判定します。</p>
          ) : <p className="helper-text">正答が未登録のため、得点を手動で入力してください。</p>}
        </div>
      )}
      {(!binary || !problem.correctAnswer?.trim()) && (
        <div className="score-fields">
          <label>得点<input autoFocus={!binary} type="number" min="0" step="0.001" value={earnedScore} onChange={(event) => setEarnedScore(event.target.valueAsNumber)} /></label>
          <span>/</span>
          <label>満点<input type="number" min="1" step="0.001" value={maxScore} onChange={(event) => setMaxScore(event.target.valueAsNumber)} /></label>
        </div>
      )}
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
    correctAnswer?: string;
  }) => Promise<void>;
}) {
  const [number, setNumber] = useState(problem.number);
  const [title, setTitle] = useState(problem.title ?? "");
  const [sectionId, setSectionId] = useState(problem.sectionId);
  const [format, setFormat] = useState(problem.evaluationTypeOverride ?? "");
  const [maxScore, setMaxScore] = useState(problem.defaultMaxScore);
  const [supplementalInfo, setSupplementalInfo] = useState(problem.supplementalInfo ?? "");
  const [correctAnswer, setCorrectAnswer] = useState(problem.correctAnswer ?? "");
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
          correctAnswer,
        });
      } catch (cause) {
        setError(toMessage(cause));
      } finally {
        setSaving(false);
      }
    }}>
      <button className="dialog-close" type="button" onClick={onCancel}>閉じる</button>
      <h2>{problem.number}を編集</h2>
      <label>教材上の番号<input value={number} onChange={(event) => setNumber(event.target.value)} required /><small className="helper-text">例: No.1、(1)、①。入力した表記をそのまま表示します。</small></label>
      <label>内容ラベル（任意）<input value={title} onChange={(event) => setTitle(event.target.value)} /><small className="helper-text">番号だけでは内容を判別しにくい場合のみ入力します。</small></label>
      <label>問題形式
        <select value={format} onChange={(event) => setFormat(event.target.value)}>
          <option value="">大問の設定を使用</option>
          <option value="binary">正誤</option>
          <option value="partial_score">部分点</option>
        </select>
      </label>
      <label>配点<input type="number" min="1" step="0.001" value={maxScore} onChange={(event) => setMaxScore(event.target.valueAsNumber)} required /></label>
      <label>正答（任意）<input value={correctAnswer} onChange={(event) => setCorrectAnswer(event.target.value)} placeholder="例: A、③、○" /><small className="helper-text">正誤問題では、自分の解答と前後の空白を除いて完全一致した場合に自動で満点になります。</small></label>
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
      <h2>{problem.number}を削除しますか？</h2>
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
  initialEditingAttemptId = "",
  onClose,
  onChanged,
  onAdd,
}: {
  problem: Problem;
  bank: QuestionBank;
  initialEditingAttemptId?: string;
  onClose: () => void;
  onChanged: () => Promise<void>;
  onAdd: (roundId: string) => void;
}) {
  const [editing, setEditing] = useState<ProblemAttempt | null>(() => (
    problem.attempts.find((attempt) => attempt.id === initialEditingAttemptId) ?? null
  ));
  const [closeOnSaveAttemptId, setCloseOnSaveAttemptId] = useState(initialEditingAttemptId);
  const [deletingAttemptId, setDeletingAttemptId] = useState("");
  const roundHistory = getPracticeRoundHistory(bank, problem);
  async function remove(id: string) {
    await service.deleteAttempt(id);
    setDeletingAttemptId("");
    await onChanged();
  }
  return (
    <div className="history-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="history-dialog" role="dialog" aria-modal="true" aria-label={`問題${problem.number}の履歴`}>
        <button className="dialog-close" onClick={onClose}>閉じる</button>
        <h2>問題 {problem.number}</h2>
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
          if (editing?.id === attempt.id) {
            return (
              <AttemptEditForm
                key={entry.roundId}
                attempt={attempt}
                problem={problem}
                roundNumber={entry.roundNumber}
                onCancel={() => {
                  setEditing(null);
                  setCloseOnSaveAttemptId("");
                }}
                onSaved={async () => {
                  const closeAfterSave = closeOnSaveAttemptId === attempt.id;
                  if (!closeAfterSave) setEditing(null);
                  await onChanged();
                  if (closeAfterSave) onClose();
                }}
              />
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
                <div><dt>自分の解答</dt><dd>{attempt.userAnswer || "—"}</dd></div>
                <div><dt>正答</dt><dd>{problem.correctAnswer || "—"}</dd></div>
                <div><dt>メモ</dt><dd>{attempt.note || "—"}</dd></div>
              </dl>
              <div className="history-entry-actions">
                <button onClick={() => {
                  setCloseOnSaveAttemptId("");
                  setEditing(attempt);
                }}>編集</button>
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
      </section>
    </div>
  );
}

export function AttemptEditForm({
  attempt,
  problem,
  roundNumber,
  onCancel,
  onSaved,
}: {
  attempt: ProblemAttempt;
  problem?: Problem;
  roundNumber: number;
  onCancel: () => void;
  onSaved: () => Promise<void>;
}) {
  const [answeredAt, setAnsweredAt] = useState(toDateTimeLocalValue(attempt.answeredAt));
  const [earned, setEarned] = useState(attempt.earnedScore);
  const [max, setMax] = useState(attempt.maxScore);
  const [confidence, setConfidence] = useState<Confidence>(attempt.confidence);
  const [note, setNote] = useState(attempt.note ?? "");
  const [userAnswer, setUserAnswer] = useState(attempt.userAnswer ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const scoreRate = Number.isFinite(earned) && Number.isFinite(max) && max > 0
    ? `${((earned / max) * 100).toFixed(1)}%`
    : "—";
  return (
    <form className="history-entry history-entry-editing" onSubmit={async (event) => {
      event.preventDefault();
      setSaving(true);
      setError("");
      try {
        await service.updateAttempt(attempt.id, {
          ...attempt,
          answeredAt: answeredAt ? new Date(answeredAt).toISOString() : null,
          earnedScore: earned,
          maxScore: max,
          confidence,
          note,
          userAnswer,
          correctAnswer: problem?.correctAnswer,
        });
        await onSaved();
      } catch (cause) {
        setError(toMessage(cause));
        setSaving(false);
      }
    }}>
      <strong>{roundNumber}周目</strong>
      <dl>
        <div><dt><label htmlFor={`attempt-${attempt.id}-answered-at`}>日時</label></dt><dd><input id={`attempt-${attempt.id}-answered-at`} type="datetime-local" value={answeredAt} onChange={(event) => setAnsweredAt(event.target.value)} /></dd></div>
        {problem?.correctAnswer?.trim() ? (
          <div><dt>得点</dt><dd>保存後に自動判定</dd></div>
        ) : (
          <>
            <div className="attempt-score-fields"><dt>得点</dt><dd><input aria-label="獲得点" type="number" min="0" step="0.001" value={earned} onChange={(event) => setEarned(event.target.valueAsNumber)} /> <span>/</span> <input aria-label="満点" type="number" min="1" step="0.001" value={max} onChange={(event) => setMax(event.target.valueAsNumber)} /></dd></div>
            <div><dt>得点率</dt><dd>{scoreRate}</dd></div>
          </>
        )}
        <div><dt><label htmlFor={`attempt-${attempt.id}-confidence`}>確信度</label></dt><dd><select id={`attempt-${attempt.id}-confidence`} value={confidence ?? ""} onChange={(event) => setConfidence((event.target.value || null) as Confidence)}><option value="">未設定</option><option value="high">高</option><option value="medium">中</option><option value="low">低</option></select></dd></div>
        <div><dt><label htmlFor={`attempt-${attempt.id}-user-answer`}>自分の解答</label></dt><dd><input id={`attempt-${attempt.id}-user-answer`} value={userAnswer} onChange={(event) => {
          setUserAnswer(event.target.value);
        }} /></dd></div>
        <div><dt>正答</dt><dd>{problem?.correctAnswer || "—"}</dd></div>
        <div className="attempt-note-field"><dt><label htmlFor={`attempt-${attempt.id}-note`}>メモ</label></dt><dd><textarea id={`attempt-${attempt.id}-note`} value={note} onChange={(event) => setNote(event.target.value)} rows={3} /></dd></div>
      </dl>
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="history-entry-actions">
        <button type="button" onClick={onCancel} disabled={saving}>キャンセル</button>
        <button className="primary-button" disabled={saving}>{saving ? "保存中…" : "保存"}</button>
      </div>
    </form>
  );
}

function ScoreMark({ result }: { result?: ReturnType<typeof deriveScoreResult> }) {
  return <span className={`score-mark ${result ?? "none"}`}>{result ? scoreMark(result) : "—"}</span>;
}

export function PracticeRoundHistoryMarks({
  bank,
  problem,
  onEditAttempt,
}: {
  bank: QuestionBank;
  problem: Problem;
  onEditAttempt?: (attemptId: string) => void;
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
                correctAnswer={problem.correctAnswer}
                onEdit={onEditAttempt ? () => onEditAttempt(entry.attempt!.id) : undefined}
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
  correctAnswer,
  onEdit,
}: {
  attempt: ProblemAttempt;
  roundNumber: number;
  correctAnswer?: string;
  onEdit?: () => void;
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
    <button
      type="button"
      className={`history-score result-${result} confidence-${attempt.confidence ?? "unset"}`}
      aria-label={`${roundNumber}周目、${scoreMark(result)}、確信度${confidence}、正答${correctAnswer || "未登録"}、自分の解答${attempt.userAnswer || "未登録"}${onEdit ? "、編集" : ""}`}
      aria-describedby={tooltipPosition ? tooltipId : undefined}
      aria-disabled={!onEdit}
      tabIndex={onEdit ? 0 : -1}
      onClick={onEdit}
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
          <span>正答: {correctAnswer || "未登録"}</span>
          <span>自分の解答: {attempt.userAnswer || "未登録"}</span>
          <span>確信度: {confidence}</span>
          <span>メモ: {attempt.note || "—"}</span>
        </span>,
        document.body,
      )}
    </button>
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
