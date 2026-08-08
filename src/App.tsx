import { ChangeEvent, FormEvent, useEffect, useMemo, useState } from "react";
import {
  createBackupJson,
  getDatabaseInfo,
  initializeState,
  loadState,
  parseBackupJson,
  saveState,
} from "./lib/storage";
import { ExerciseView } from "./questionBank/QuestionBankView";
import { MaterialMasterView } from "./questionBank/MaterialMasterView";
import { syncAnki } from "./lib/ankiConnect";
import {
  calculateLevel,
  calculateTotalXp,
  calculateXpBreakdown,
  manualDraftToActivities,
  nextLevelXp,
  type XpBreakdownItem,
} from "./lib/progression";
import {
  calculatePlanReadiness,
  calculateResourcePaces,
  findSimilarResource,
  generateStudyPlanPrompt,
  toStudyPlan,
  validateStudyPlanJson,
} from "./lib/studyPlan";
import type {
  ActivityType,
  AppState,
  ImportedStudyPlan,
  ManualEntryDraft,
  ResourceStartCondition,
  ResourceStartConditionType,
  StudyPlan,
  StudyPlanPriority,
  StudyResource,
  StudyResourceMergeMode,
  StudyResourceType,
  SyncStatus,
} from "./types";

type ViewId =
  | "dashboard"
  | "goals"
  | "resources"
  | "questionBanks"
  | "aiPlan"
  | "pace"
  | "sync"
  | "manual"
  | "collection"
  | "unlocks"
  | "data";

type AiPlanTabId = "progress" | "update";

const navItems: Array<{ id: ViewId; label: string; mark: string }> = [
  { id: "dashboard", label: "ダッシュボード", mark: "D" },
  { id: "goals", label: "目標管理", mark: "G" },
  { id: "resources", label: "教材管理", mark: "R" },
  { id: "questionBanks", label: "演習", mark: "Q" },
  { id: "aiPlan", label: "AI学習計画", mark: "AI" },
  { id: "pace", label: "ペース管理", mark: "P" },
  { id: "sync", label: "Anki同期", mark: "A" },
  { id: "manual", label: "手入力", mark: "M" },
  { id: "collection", label: "コレクション", mark: "C" },
  { id: "unlocks", label: "アンロック", mark: "U" },
  { id: "data", label: "データ管理", mark: "B" },
];

const aiPlanTabs: Array<{ id: AiPlanTabId; label: string }> = [
  { id: "progress", label: "進捗を見る" },
  { id: "update", label: "計画を作る・更新する" },
];

const emptyDraft: ManualEntryDraft = {
  textbookPages: 0,
  exerciseCount: 0,
  correctCount: 0,
  mockExamScore: 0,
  listeningMinutes: 0,
  readAloudCount: 0,
};

const xpRuleLabels: Record<ActivityType, string> = {
  ankiReview: "Ankiレビュー 1枚",
  ankiNew: "Anki新規 1枚",
  textbookPage: "テキスト 1ページ",
  exercise: "問題演習 1問",
  mockExam: "模試 1回",
  listeningMinute: "リスニング 1分",
  readAloud: "音読 1回",
};

interface ResourceDraft {
  id?: string;
  name: string;
  type: StudyResourceType;
  unit: string;
  targetAmount: number;
  currentAmount: number;
  startDate: string;
  endDate: string;
  notes: string;
  startConditionType: ResourceStartConditionType;
  startConditionResourceId: string;
  startConditionThreshold: number;
  startConditionDate: string;
  startConditionNotes: string;
}

interface GoalDraft {
  id?: string;
  title: string;
  examDate: string;
  targetXp: number;
}

const emptyGoalDraft: GoalDraft = {
  title: "",
  examDate: "",
  targetXp: 3000,
};

const emptyResourceDraft: ResourceDraft = {
  name: "",
  type: "book",
  unit: "pages",
  targetAmount: 0,
  currentAmount: 0,
  startDate: "",
  endDate: "",
  notes: "",
  startConditionType: "none",
  startConditionResourceId: "",
  startConditionThreshold: 80,
  startConditionDate: "",
  startConditionNotes: "",
};

const editableResourceTypes = ["book", "exam", "audio", "csv", "manual", "other"] as const;

const resourceTypeLabels: Record<(typeof editableResourceTypes)[number], string> = {
  book: "書籍",
  exam: "模試",
  audio: "音声",
  csv: "CSV",
  manual: "手入力",
  other: "その他",
};

const resourceUnitOptions = [
  { value: "pages", label: "ページ" },
  { value: "questions", label: "問" },
  { value: "times", label: "回" },
  { value: "sets", label: "セット" },
  { value: "hours", label: "時間" },
  { value: "minutes", label: "分" },
  { value: "words", label: "語" },
  { value: "lessons", label: "レッスン" },
];

const priorityLabels: Record<StudyPlanPriority, string> = {
  high: "高",
  medium: "中",
  low: "低",
};

const startConditionLabels: Record<ResourceStartConditionType, string> = {
  none: "なし",
  immediate: "すぐ開始",
  manual: "手動で判断",
  afterResourceStarted: "教材を開始後",
  afterResourceCompleted: "教材を完了後",
  afterResourceProgress: "教材がN%以上完了後",
  afterResourceAccuracy: "教材がN%以上正解後",
  afterResourceAmount: "教材の現在量がN以上",
  afterDate: "日付以降",
};

function formatDateTime(value?: string) {
  if (!value) return "未同期";
  return new Intl.DateTimeFormat("ja-JP", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function App() {
  const [state, setState] = useState<AppState>(() => loadState());
  const [stateReady, setStateReady] = useState(false);
  const [activeView, setActiveView] = useState<ViewId>("dashboard");
  const [selectedGoalId, setSelectedGoalId] = useState("chuken-2");
  const [syncStatus, setSyncStatus] = useState<SyncStatus>("idle");
  const [syncMessage, setSyncMessage] = useState("AnkiConnectからデータを取得できます。");
  const [draft, setDraft] = useState<ManualEntryDraft>(emptyDraft);
  const [toastMessage, setToastMessage] = useState("");

  useEffect(() => {
    void initializeState()
      .then((result) => {
        setState(result.state);
        if (result.message) showToast(result.message);
      })
      .catch((error) => showToast(`データベースを初期化できませんでした: ${String(error)}`))
      .finally(() => setStateReady(true));
  }, []);

  useEffect(() => {
    if (!stateReady) return;
    void saveState(state).catch((error) => showToast(`SQLiteへの保存に失敗しました: ${String(error)}`));
  }, [state, stateReady]);

  useEffect(() => {
    if (!toastMessage) return;
    const timer = window.setTimeout(() => setToastMessage(""), 2400);
    return () => window.clearTimeout(timer);
  }, [toastMessage]);

  function showToast(message: string) {
    setToastMessage(message);
  }

  const goal = state.goals.find((item) => item.id === selectedGoalId) ?? state.goals[0];
  const goalSkills = state.skills.filter((skill) => skill.goalId === goal.id);
  const goalCollections = state.collections.filter((collection) => collection.goalId === goal.id);
  const goalQuests = state.quests.filter((quest) => quest.goalId === goal.id);
  const goalCities = state.cityRewards.filter((reward) => reward.goalId === goal.id);
  const currentPlan = state.studyPlans.find((plan) => plan.goalId === goal.id);
  const currentXp = calculateTotalXp(goal, state.activities);
  const xpBreakdown = calculateXpBreakdown(goal, state.activities);
  const level = calculateLevel(currentXp);
  const nextXp = nextLevelXp(level);
  const previousLevelXp = level <= 1 ? 0 : nextLevelXp(level - 1);
  const levelProgress = Math.min(
    100,
    Math.round(((currentXp - previousLevelXp) / (nextXp - previousLevelXp)) * 100),
  );
  const readiness = currentPlan ? calculatePlanReadiness(currentPlan) : 0;
  const manualSource = state.sources.find(
    (source) => source.goalId === goal.id && source.type === "manual",
  );

  const todaysManualSummary = useMemo(() => {
    const today = new Date().toDateString();
    const activities = state.activities.filter(
      (activity) =>
        activity.goalId === goal.id &&
        activity.sourceId === manualSource?.id &&
        new Date(activity.occurredAt).toDateString() === today,
    );

    return {
      textbookPages: activities
        .filter((activity) => activity.type === "textbookPage")
        .reduce((sum, activity) => sum + activity.amount, 0),
      exercises: activities
        .filter((activity) => activity.type === "exercise")
        .reduce((sum, activity) => sum + activity.amount, 0),
      correct: activities
        .filter((activity) => activity.type === "exercise")
        .reduce((sum, activity) => sum + (activity.correct ?? 0), 0),
      readAloud: activities
        .filter((activity) => activity.type === "readAloud")
        .reduce((sum, activity) => sum + activity.amount, 0),
    };
  }, [goal.id, manualSource?.id, state.activities]);

  async function handleAnkiSync() {
    setSyncStatus("idle");
    setSyncMessage("AnkiConnectへ接続しています...");

    try {
      const anki = await syncAnki();
      setState((current) => {
        const ankiActivities = [
          {
            id: `anki-review-total-${goal.id}`,
            goalId: goal.id,
            sourceId: "anki",
            type: "ankiReview" as const,
            amount: anki.totalReviewCount,
            occurredAt: new Date().toISOString(),
            note: "Anki対象デッキの全期間レビュー履歴",
          },
          {
            id: `anki-new-total-${goal.id}`,
            goalId: goal.id,
            sourceId: "anki",
            type: "ankiNew" as const,
            amount: anki.totalLearnedCardCount,
            occurredAt: new Date().toISOString(),
            note: "Anki対象デッキの学習済みカード数",
          },
        ].filter((activity) => activity.amount > 0);

        return {
          ...current,
          anki,
          activities: [
            ...current.activities.filter(
              (activity) =>
                !(
                  activity.goalId === goal.id &&
                  activity.sourceId === "anki" &&
                  (activity.type === "ankiReview" || activity.type === "ankiNew")
                ),
            ),
            ...ankiActivities,
          ],
        };
      });
      setSyncStatus("success");
      setSyncMessage("AnkiConnectとの同期が完了しました。");
    } catch {
      setSyncStatus("error");
      setSyncMessage(
        "Ankiが起動していません。Mac版Ankiを起動してから再同期してください。",
      );
    }
  }

  function updateDraft(key: keyof ManualEntryDraft, value: string) {
    setDraft((current) => ({ ...current, [key]: Math.max(0, Number(value) || 0) }));
  }

  function handleManualSubmit(event: FormEvent) {
    event.preventDefault();
    if (!manualSource) return;

    const activities = manualDraftToActivities(goal.id, manualSource.id, draft);
    if (!activities.length) return;

    setState((current) => ({
      ...current,
      activities: [...current.activities, ...activities],
    }));
    setDraft(emptyDraft);
  }

  function handleStudyPlanSave(plan: StudyPlan) {
    setState((current) => ({
      ...current,
      studyPlans: [...current.studyPlans.filter((item) => item.goalId !== plan.goalId), plan],
    }));
  }

  function handleGoalSave(draft: GoalDraft) {
    if (!draft.title.trim()) return;
    const newGoalId = draft.id ? undefined : `goal-${Date.now()}`;

    setState((current) => {
      if (draft.id) {
        return {
          ...current,
          goals: current.goals.map((item) =>
            item.id === draft.id
              ? {
                  ...item,
                  title: draft.title.trim(),
                  examDate: draft.examDate || undefined,
                  targetXp: draft.targetXp,
                }
              : item,
          ),
        };
      }

      const goalId = newGoalId ?? `goal-${Date.now()}`;
      return {
        ...current,
        goals: [
          ...current.goals,
          {
            id: goalId,
            title: draft.title.trim(),
            subtitle: "",
            status: "active",
            readiness: 0,
            targetXp: draft.targetXp,
            xp: 0,
            examDate: draft.examDate || undefined,
            skillIds: [],
            collectionIds: [],
          },
        ],
        sources: [
          ...current.sources,
          { id: `manual-${goalId}`, goalId, type: "manual", label: "手入力" },
        ],
      };
    });

    if (newGoalId) {
      setSelectedGoalId(newGoalId);
    }
  }

  function handleGoalDelete(goalId: string) {
    if (state.goals.length <= 1) return;

    setState((current) => ({
      ...current,
      goals: current.goals.filter((item) => item.id !== goalId),
      skills: current.skills.filter((item) => item.goalId !== goalId),
      collections: current.collections.filter((item) => item.goalId !== goalId),
      sources: current.sources.filter((item) => item.goalId !== goalId),
      activities: current.activities.filter((item) => item.goalId !== goalId),
      quests: current.quests.filter((item) => item.goalId !== goalId),
      cityRewards: current.cityRewards.filter((item) => item.goalId !== goalId),
      studyPlans: current.studyPlans.filter((item) => item.goalId !== goalId),
    }));

    if (selectedGoalId === goalId) {
      const fallback = state.goals.find((item) => item.id !== goalId);
      setSelectedGoalId(fallback?.id ?? "chuken-2");
      setActiveView("dashboard");
    }
  }

  return (
    <div className="app-shell">
      {toastMessage && <Toast message={toastMessage} />}
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">GF</div>
          <div>
            <strong>GoalForge</strong>
            <span>学習進捗管理</span>
          </div>
        </div>
        <nav className="nav-list" aria-label="主要画面">
          <div className="sidebar-section-title">表示</div>
          {navItems.map((item) => (
            <button
              className={activeView === item.id ? "nav-item active" : "nav-item"}
              key={item.id}
              onClick={() => setActiveView(item.id)}
            >
              <span>{item.mark}</span>
              {item.label}
            </button>
          ))}
        </nav>
      </aside>

      <main className="main">
        <div className="sticky-header">
          <div className="global-goal-bar" aria-label="学習目標の切り替え">
            <div className="global-goal-title">
              <span>GoalForge</span>
              <strong>学習目標</strong>
            </div>
            <label>
              <span>現在の目標</span>
              <select onChange={(event) => setSelectedGoalId(event.target.value)} value={goal.id}>
                {state.goals.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.title}
                  </option>
                ))}
              </select>
            </label>
            <button className="secondary-button" onClick={() => setActiveView("goals")} type="button">
              目標管理
            </button>
          </div>
        </div>

        <header className="topbar">
          <div>
            <h1>{viewTitle(activeView, goal.title)}</h1>
            <p>{topbarDescription(activeView, goal.title)}</p>
          </div>
          <div className="goal-meta-card">
            <dl>
              <div>
                <dt>試験日</dt>
                <dd>{goal.examDate ?? "未設定"}</dd>
              </div>
              <div>
                <dt>目標XP</dt>
                <dd>{goal.targetXp.toLocaleString()}</dd>
              </div>
            </dl>
          </div>
        </header>

        {activeView === "goals" && (
          <GoalManagementView
            goals={state.goals}
            onDelete={handleGoalDelete}
            onSave={handleGoalSave}
            onSelectGoal={setSelectedGoalId}
            selectedGoalId={goal.id}
            onNotify={showToast}
          />
        )}

        {activeView === "dashboard" && (
          <DashboardView
            goalTitle={goal.title}
            readiness={readiness}
            currentXp={currentXp}
            level={level}
            levelProgress={levelProgress}
            nextXp={nextXp}
            targetXp={goal.targetXp}
            skills={goalSkills}
            collections={goalCollections}
            quests={goalQuests}
            anki={state.anki}
            syncStatus={syncStatus}
            syncMessage={syncMessage}
            onSync={handleAnkiSync}
            baseXp={goal.xp}
            xpBreakdown={xpBreakdown}
          />
        )}

        {activeView === "sync" && (
          <SyncView
            status={syncStatus}
            message={syncMessage}
            anki={state.anki}
            onSync={handleAnkiSync}
          />
        )}

        {activeView === "resources" && (
          <MaterialMasterView goalId={goal.id} goal={goal} studyPlan={currentPlan} onNotify={showToast} />
        )}

        {activeView === "questionBanks" && <ExerciseView />}

        {activeView === "aiPlan" && (
          <AiStudyPlanView
            anki={state.anki}
            currentXp={currentXp}
            goal={goal}
            existingPlan={currentPlan}
            onNotify={showToast}
            onSave={handleStudyPlanSave}
            xpBreakdown={xpBreakdown}
          />
        )}

        {activeView === "pace" && <PaceView plan={currentPlan} readiness={readiness} />}

        {activeView === "manual" && (
          <ManualView
            goalTitle={goal.title}
            draft={draft}
            summary={todaysManualSummary}
            onChange={updateDraft}
            onSubmit={handleManualSubmit}
          />
        )}

        {activeView === "collection" && <CollectionView collections={goalCollections} />}

        {activeView === "unlocks" && (
          <UnlockView cities={goalCities} currentXp={currentXp} level={level} />
        )}

        {activeView === "data" && (
          <DataManagementView
            onImport={(nextState) => {
              setState(nextState);
              setSelectedGoalId(nextState.goals[0]?.id ?? "chuken-2");
              setActiveView("dashboard");
            }}
            onNotify={showToast}
            state={state}
          />
        )}
      </main>
    </div>
  );
}

function viewTitle(view: ViewId, goalTitle: string) {
  const titles: Record<ViewId, string> = {
    dashboard: `${goalTitle} ダッシュボード`,
    goals: "目標管理",
    resources: "教材管理",
    questionBanks: "演習・解答履歴",
    aiPlan: "AI学習計画",
    pace: "ペース管理",
    sync: "AnkiConnect同期",
    manual: "手入力記録",
    collection: "コレクション進捗（サンプル）",
    unlocks: "都市アンロック",
    data: "データ管理",
  };
  return titles[view];
}

function topbarDescription(view: ViewId, goalTitle: string) {
  if (view === "data") {
    return "全学習目標のデータを一括でバックアップ・復元します。";
  }
  if (view === "goals") {
    return "学習目標を追加・編集・削除します。";
  }
  if (view === "questionBanks") {
    return "教材マスターを使って演習し、解答履歴・周回・復習状態を管理します。";
  }
  if (view === "resources") {
    return "教材・セクション・問題の構造を管理する唯一のマスターです。";
  }
  return `${goalTitle} に対するAnki・手入力・模試の進捗を見える化します。`;
}

function Toast({ message }: { message: string }) {
  return (
    <div aria-live="polite" className="toast-message">
      {message}
    </div>
  );
}

function DashboardView({
  goalTitle,
  readiness,
  currentXp,
  level,
  levelProgress,
  nextXp,
  targetXp,
  skills,
  collections,
  quests,
  anki,
  syncStatus,
  syncMessage,
  onSync,
  baseXp,
  xpBreakdown,
}: {
  goalTitle: string;
  readiness: number;
  currentXp: number;
  level: number;
  levelProgress: number;
  nextXp: number;
  targetXp: number;
  skills: AppState["skills"];
  collections: AppState["collections"];
  quests: AppState["quests"];
  anki: AppState["anki"];
  syncStatus: SyncStatus;
  syncMessage: string;
  onSync: () => void;
  baseXp: number;
  xpBreakdown: XpBreakdownItem[];
}) {
  const [isXpHelpOpen, setIsXpHelpOpen] = useState(false);
  const earnedXp = xpBreakdown.reduce((sum, item) => sum + item.xp, 0);
  const targetProgress = targetXp > 0 ? Math.min(100, Math.round((currentXp / targetXp) * 100)) : 0;

  return (
    <div className="dashboard-grid">
      <section className="readiness-panel panel">
        <div>
          <h2>合格準備度</h2>
          <p>{goalTitle}の現在地</p>
          <p className="readiness-note">学習計画の教材進捗を重要度で加重平均</p>
        </div>
        <div className="gauge" style={{ "--value": `${readiness * 3.6}deg` } as React.CSSProperties}>
          <span>{readiness}%</span>
        </div>
      </section>

      <section className="xp-panel panel">
        <div className="panel-title-row">
          <span>XP</span>
          <button
            aria-expanded={isXpHelpOpen}
            aria-label="XP計算ルールを表示"
            className="round-help-button"
            onClick={() => setIsXpHelpOpen((current) => !current)}
            type="button"
          >
            ?
          </button>
        </div>
        <strong>{currentXp.toLocaleString()}</strong>
        <div className="xp-target-row">
          <span>目標XP {targetXp.toLocaleString()}</span>
          <strong>{targetProgress}%</strong>
        </div>
        <div className="bar target-xp-bar" aria-label={`目標XP進捗 ${targetProgress}%`}>
          <span style={{ width: `${targetProgress}%` }} />
        </div>
        <div className="level-row">
          <span>Lv.{level}</span>
          <span>次: {nextXp.toLocaleString()} XP</span>
        </div>
        <div className="bar">
          <span style={{ width: `${levelProgress}%` }} />
        </div>
        {isXpHelpOpen && (
          <div className="xp-help-panel">
            <strong>XP獲得内訳</strong>
            <p>
              記録から {earnedXp.toLocaleString()}XP
              {baseXp > 0 ? `、初期XP ${baseXp.toLocaleString()}XP` : ""} を集計しています。
            </p>
            <ul>
              {xpBreakdown.map((item) => (
                <li key={item.type}>
                  <span>
                    {xpRuleLabels[item.type]} × {item.amount.toLocaleString()} ={" "}
                    {item.xp.toLocaleString()}XP
                  </span>
                  <em>{item.xpPerUnit}XP/単位</em>
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>

      <section className="panel quest-panel">
        <h2>今日のクエスト（サンプル）</h2>
        <div className="quest-list">
          {quests.map((quest) => (
            <article key={quest.id} className="quest-row">
              <div>
                <strong>{quest.title}</strong>
                <span>
                  {quest.progress}/{quest.target}
                  {quest.unit} ・ {quest.xp}XP
                </span>
              </div>
              <div className="mini-bar">
                <span style={{ width: `${Math.min(100, (quest.progress / quest.target) * 100)}%` }} />
              </div>
            </article>
          ))}
        </div>
      </section>

      <section className="panel">
        <h2>スキル別進捗（サンプル）</h2>
        <ProgressList items={skills.map((skill) => ({ ...skill, value: skill.progress }))} />
      </section>

      <section className="panel">
        <h2>コレクション進捗（サンプル）</h2>
        <ProgressList
          items={collections.map((collection) => ({
            id: collection.id,
            name: collection.name,
            level: collection.level,
            value: Math.round((collection.collected / collection.total) * 100),
            caption: `${collection.collected}/${collection.total}`,
          }))}
        />
      </section>

      <section className="panel anki-mini">
        <div className="panel-title-row">
          <h2>Anki状態</h2>
          <button className="secondary-button compact-button" onClick={onSync} type="button">
            Ankiと同期
          </button>
        </div>
        <div className={`sync-message compact ${syncStatus}`}>{syncMessage}</div>
        <dl>
          <div>
            <dt>前回同期</dt>
            <dd>{formatDateTime(anki.syncedAt)}</dd>
          </div>
          <div>
            <dt>対象デッキ</dt>
            <dd>{anki.targetDeckName ?? "未選択"}</dd>
          </div>
          <div>
            <dt>対象デッキの全期間レビュー</dt>
            <dd>{anki.totalReviewCount.toLocaleString()}回</dd>
          </div>
          <div>
            <dt>対象デッキの学習済みカード</dt>
            <dd>{anki.totalLearnedCardCount.toLocaleString()}枚</dd>
          </div>
        </dl>
      </section>
    </div>
  );
}

function GoalManagementView({
  goals,
  selectedGoalId,
  onSelectGoal,
  onSave,
  onDelete,
  onNotify,
}: {
  goals: AppState["goals"];
  selectedGoalId: string;
  onSelectGoal: (goalId: string) => void;
  onSave: (draft: GoalDraft) => void;
  onDelete: (goalId: string) => void;
  onNotify: (message: string) => void;
}) {
  const [draft, setDraft] = useState<GoalDraft>(emptyGoalDraft);
  const [message, setMessage] = useState("");

  function handleEdit(goal: AppState["goals"][number]) {
    setDraft({
      id: goal.id,
      title: goal.title,
      examDate: goal.examDate ?? "",
      targetXp: goal.targetXp,
    });
    setMessage("");
  }

  function handleReset() {
    setDraft(emptyGoalDraft);
    setMessage("");
  }

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!draft.title.trim()) {
      setMessage("目標名を入力してください。");
      return;
    }

    onSave(draft);
    onNotify(draft.id ? "学習目標を更新しました。" : "学習目標を追加しました。");
    setMessage("");
    setDraft(emptyGoalDraft);
  }

  return (
    <section className="goal-management-layout">
      <form className="panel goal-form" onSubmit={handleSubmit}>
        <div className="section-heading">
          <h2>{draft.id ? "学習目標を編集" : "学習目標を追加"}</h2>
          <p>ここで作成した目標はヘッダーのリストから選択できます。</p>
        </div>
        <label className="field">
          <span>目標名</span>
          <input
            onChange={(event) => setDraft((current) => ({ ...current, title: event.target.value }))}
            placeholder="例: 中国語検定2級"
            value={draft.title}
          />
        </label>
        <div className="form-grid">
          <label className="field">
            <span>試験日</span>
            <input
              onChange={(event) => setDraft((current) => ({ ...current, examDate: event.target.value }))}
              type="date"
              value={draft.examDate}
            />
          </label>
          <NumberField
            label="目標XP"
            onChange={(value) =>
              setDraft((current) => ({ ...current, targetXp: Math.max(0, Number(value) || 0) }))
            }
            value={draft.targetXp}
          />
        </div>
        <div className="button-row">
          <button className="primary-button" type="submit">
            {draft.id ? "更新する" : "追加する"}
          </button>
          <button className="secondary-button" onClick={handleReset} type="button">
            クリア
          </button>
        </div>
        {message && <p className={message.includes("入力") ? "error-text" : "success-text"}>{message}</p>}
      </form>

      <div className="panel goal-list-panel">
        <div className="section-heading">
          <h2>登録済み目標</h2>
          <p>{goals.length}件の学習目標を管理中</p>
        </div>
        <div className="goal-list">
          {goals.map((goal) => (
            <article className={goal.id === selectedGoalId ? "goal-row active" : "goal-row"} key={goal.id}>
              <div>
                <strong>{goal.title}</strong>
                <span>試験日: {goal.examDate ?? "未設定"} / 目標XP: {goal.targetXp.toLocaleString()}</span>
              </div>
              <div className="resource-actions">
                <button className="secondary-button" onClick={() => onSelectGoal(goal.id)} type="button">
                  選択
                </button>
                <button className="secondary-button" onClick={() => handleEdit(goal)} type="button">
                  編集
                </button>
                <button
                  className="secondary-button danger-button"
                  disabled={goals.length <= 1}
                  onClick={() => {
                    onDelete(goal.id);
                    onNotify("学習目標を削除しました。");
                  }}
                  type="button"
                >
                  削除
                </button>
              </div>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}

function ProgressList({
  items,
}: {
  items: Array<{ id: string; name: string; level: number; value: number; caption?: string }>;
}) {
  return (
    <div className="progress-list">
      {items.map((item) => (
        <div className="progress-row" key={item.id}>
          <div>
            <strong>{item.name}</strong>
            <span>Lv.{item.level}</span>
          </div>
          <div className="bar">
            <span style={{ width: `${item.value}%` }} />
          </div>
          <em>{item.caption ?? `${item.value}%`}</em>
        </div>
      ))}
    </div>
  );
}

function resourceFromDraft(draft: ResourceDraft): StudyResource {
  return {
    id: draft.id ?? `resource-${Date.now()}`,
    name: draft.name.trim(),
    type: draft.type,
    unit: draft.unit.trim() || "items",
    targetAmount: draft.targetAmount,
    currentAmount: draft.currentAmount,
    weight: 0,
    weeklyTarget: 0,
    priority: "medium",
    startDate: draft.startDate || undefined,
    endDate: draft.endDate || undefined,
    notes: draft.notes.trim(),
    startCondition: startConditionFromDraft(draft),
  };
}

function startConditionFromDraft(draft: ResourceDraft): ResourceStartCondition | undefined {
  if (draft.startConditionType === "none") return undefined;

  return {
    type: draft.startConditionType,
    resourceId: draft.startConditionResourceId || undefined,
    threshold:
      draft.startConditionType === "afterResourceProgress" ||
      draft.startConditionType === "afterResourceAccuracy" ||
      draft.startConditionType === "afterResourceAmount"
        ? draft.startConditionThreshold
        : undefined,
    date: draft.startConditionType === "afterDate" ? draft.startConditionDate || undefined : undefined,
    notes: draft.startConditionNotes.trim() || undefined,
  };
}

function draftFromResource(resource: StudyResource): ResourceDraft {
  const condition = resource.startCondition;
  return {
    id: resource.id,
    name: resource.name,
    type: resource.type === "anki" ? "book" : resource.type,
    unit: resource.unit,
    targetAmount: resource.targetAmount,
    currentAmount: resource.currentAmount,
    startDate: resource.startDate ?? "",
    endDate: resource.endDate ?? "",
    notes: resource.notes,
    startConditionType: condition?.type ?? "none",
    startConditionResourceId: condition?.resourceId ?? "",
    startConditionThreshold: condition?.threshold ?? 80,
    startConditionDate: condition?.date ?? "",
    startConditionNotes: condition?.notes ?? "",
  };
}

function studyResourceTypeLabel(type: StudyResourceType) {
  if (type === "anki") return "Anki";
  return resourceTypeLabels[type];
}

function studyResourceUnitLabel(unit: string) {
  return resourceUnitOptions.find((option) => option.value === unit)?.label ?? unit;
}

function formatResourceStartCondition(condition: ResourceStartCondition | undefined, resources: StudyResource[]) {
  if (!condition) return "なし";
  const resourceName = condition.resourceId
    ? resources.find((resource) => resource.id === condition.resourceId)?.name ?? "対象教材"
    : "対象教材";
  const threshold = condition.threshold ?? 0;

  switch (condition.type) {
    case "immediate":
      return "すぐ開始";
    case "manual":
      return condition.notes ?? "手動で開始判断";
    case "afterResourceStarted":
      return `${resourceName} を開始後`;
    case "afterResourceCompleted":
      return `${resourceName} を完了後`;
    case "afterResourceProgress":
      return `${resourceName} が ${threshold}% 以上完了後`;
    case "afterResourceAccuracy":
      return `${resourceName} が ${threshold}% 以上正解後`;
    case "afterResourceAmount":
      return `${resourceName} が ${threshold} 以上になった後`;
    case "afterDate":
      return `${condition.date ?? "日付未指定"} 以降`;
    default:
      return condition.notes ?? "なし";
  }
}

function buildPlanWithResources(
  goal: AppState["goals"][number],
  plan: StudyPlan | undefined,
  resources: StudyResource[],
): StudyPlan {
  const now = new Date().toISOString();
  const examDate = plan?.examDate ?? goal.examDate ?? new Date().toLocaleDateString("en-CA");
  return {
    id: plan?.id ?? `plan-${goal.id}-${Date.now()}`,
    goalId: goal.id,
    planName: plan?.planName ?? `${goal.title} 学習計画`,
    examDate,
    overallStrategy: plan?.overallStrategy ?? "",
    resources: withResourceDates(resources, plan?.importedAt ?? now, examDate),
    milestones: plan?.milestones ?? [],
    warnings: plan?.warnings ?? [],
    importedAt: plan?.importedAt ?? now,
    resourceMergeModes: plan?.resourceMergeModes ?? {},
  };
}

function withResourceDates(resources: StudyResource[], importedAt: string, examDate: string) {
  if (!resources.length) return resources;
  const start = toDateValue(importedAt);
  const end = toDateValue(examDate);
  const startDate = new Date(`${start}T00:00:00`);
  const endDate = new Date(`${end}T00:00:00`);
  const span = Math.max(1, endDate.getTime() - startDate.getTime());

  return resources.map((resource, index) => {
    if (resource.startDate && resource.endDate) return resource;
    const resourceStart = new Date(startDate.getTime() + (span * index) / resources.length);
    const resourceEnd = new Date(startDate.getTime() + (span * (index + 1)) / resources.length);
    return {
      ...resource,
      startDate: resource.startDate || toDateValue(resourceStart.toISOString()),
      endDate: resource.endDate || toDateValue(resourceEnd.toISOString()),
    };
  });
}

function toDateValue(value: string) {
  const date = new Date(value.includes("T") ? value : `${value}T00:00:00`);
  if (Number.isNaN(date.getTime())) return new Date().toLocaleDateString("en-CA");
  return date.toLocaleDateString("en-CA");
}

function ResourceManagementView({
  goal,
  plan,
  onSave,
  onNotify,
}: {
  goal: AppState["goals"][number];
  plan?: StudyPlan;
  onSave: (plan: StudyPlan) => void;
  onNotify: (message: string) => void;
}) {
  const [draft, setDraft] = useState<ResourceDraft>(emptyResourceDraft);
  const [message, setMessage] = useState("");
  const resources = plan?.resources ?? [];

  function updateDraft<K extends keyof ResourceDraft>(key: K, value: ResourceDraft[K]) {
    setDraft((current) => ({ ...current, [key]: value }));
  }

  function handleEdit(resource: StudyResource) {
    setDraft(draftFromResource(resource));
    setMessage("");
  }

  function handleReset() {
    setDraft(emptyResourceDraft);
    setMessage("");
  }

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!draft.name.trim()) {
      setMessage("教材名を入力してください。");
      return;
    }
    if (draft.targetAmount <= 0) {
      setMessage("目標量は1以上にしてください。");
      return;
    }

    const resource = resourceFromDraft(draft);
    const nextResources = draft.id
      ? resources.map((item) => (item.id === draft.id ? resource : item))
      : [...resources, resource];

    onSave(buildPlanWithResources(goal, plan, nextResources));
    setDraft(emptyResourceDraft);
    setMessage("");
    onNotify(draft.id ? "教材を更新しました。" : "教材を追加しました。");
  }

  function handleDelete(resourceId: string) {
    onSave(buildPlanWithResources(goal, plan, resources.filter((resource) => resource.id !== resourceId)));
    if (draft.id === resourceId) {
      setDraft(emptyResourceDraft);
    }
    setMessage("");
    onNotify("教材を削除しました。");
  }

  return (
    <section className="resource-management-layout">
      <form className="panel resource-form" onSubmit={handleSubmit}>
        <div className="section-heading">
          <h2>{draft.id ? "教材を編集" : "教材を追加"}</h2>
          <p>登録した教材はAI学習計画プロンプトとペース管理に反映されます。</p>
        </div>
        <label className="field">
          <span>教材名</span>
          <input
            onChange={(event) => updateDraft("name", event.target.value)}
            placeholder="例: キクタン中国語 初中級編"
            value={draft.name}
          />
        </label>
        <div className="form-grid">
          <label className="field">
            <span>種別</span>
            <select
              onChange={(event) => {
                const type = event.target.value as StudyResourceType;
                updateDraft("type", type);
              }}
              value={draft.type}
            >
              {editableResourceTypes.map((type) => (
                <option key={type} value={type}>
                  {resourceTypeLabels[type]}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>単位</span>
            <select onChange={(event) => updateDraft("unit", event.target.value)} value={draft.unit}>
              {!resourceUnitOptions.some((option) => option.value === draft.unit) && draft.unit && (
                <option value={draft.unit}>{draft.unit}</option>
              )}
              {resourceUnitOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <NumberField
            label="目標量"
            onChange={(value) => updateDraft("targetAmount", Math.max(0, Number(value) || 0))}
            value={draft.targetAmount}
          />
          <NumberField
            label="現在量"
            onChange={(value) => updateDraft("currentAmount", Math.max(0, Number(value) || 0))}
            value={draft.currentAmount}
          />
          <label className="field">
            <span>開始日</span>
            <input
              onChange={(event) => updateDraft("startDate", event.target.value)}
              type="date"
              value={draft.startDate}
            />
          </label>
          <label className="field">
            <span>終了日</span>
            <input
              onChange={(event) => updateDraft("endDate", event.target.value)}
              type="date"
              value={draft.endDate}
            />
          </label>
        </div>
        <div className="resource-condition-box">
          <h3>開始条件</h3>
          <div className="form-grid">
            <label className="field">
              <span>条件タイプ</span>
              <select
                onChange={(event) => updateDraft("startConditionType", event.target.value as ResourceStartConditionType)}
                value={draft.startConditionType}
              >
                {Object.entries(startConditionLabels).map(([type, label]) => (
                  <option key={type} value={type}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            {draft.startConditionType !== "none" && draft.startConditionType !== "afterDate" && (
              <label className="field">
                <span>対象教材</span>
                <select
                  onChange={(event) => updateDraft("startConditionResourceId", event.target.value)}
                  value={draft.startConditionResourceId}
                >
                  <option value="">未選択</option>
                  {resources
                    .filter((resource) => resource.id !== draft.id)
                    .map((resource) => (
                      <option key={resource.id} value={resource.id}>
                        {resource.name}
                      </option>
                    ))}
                </select>
              </label>
            )}
            {(draft.startConditionType === "afterResourceProgress" ||
              draft.startConditionType === "afterResourceAccuracy" ||
              draft.startConditionType === "afterResourceAmount") && (
              <NumberField
                label={draft.startConditionType === "afterResourceAmount" ? "しきい値" : "しきい値"}
                onChange={(value) => updateDraft("startConditionThreshold", Math.max(0, Number(value) || 0))}
                suffix={draft.startConditionType === "afterResourceAmount" ? undefined : "%"}
                value={draft.startConditionThreshold}
              />
            )}
            {draft.startConditionType === "afterDate" && (
              <label className="field">
                <span>開始日</span>
                <input
                  onChange={(event) => updateDraft("startConditionDate", event.target.value)}
                  type="date"
                  value={draft.startConditionDate}
                />
              </label>
            )}
          </div>
          {draft.startConditionType !== "none" && (
            <label className="field">
              <span>開始条件メモ</span>
              <input
                onChange={(event) => updateDraft("startConditionNotes", event.target.value)}
                placeholder="例: 正解率が安定してから過去問に入る"
                value={draft.startConditionNotes}
              />
            </label>
          )}
        </div>
        <label className="field">
          <span>メモ</span>
          <textarea
            onChange={(event) => updateDraft("notes", event.target.value)}
            placeholder="使い方、苦手範囲、進め方など"
            value={draft.notes}
          />
        </label>
        <div className="button-row">
          <button className="primary-button" type="submit">
            {draft.id ? "更新する" : "追加する"}
          </button>
          <button className="secondary-button" onClick={handleReset} type="button">
            クリア
          </button>
        </div>
        {message && <p className={message.includes("入力") || message.includes("目標") ? "error-text" : "success-text"}>{message}</p>}
      </form>

      <div className="panel resource-list-panel">
        <div className="section-heading">
          <h2>登録済み教材</h2>
          <p>{resources.length ? `${resources.length}件の教材を管理中` : "まだ教材は登録されていません。"}</p>
        </div>
        <div className="resource-card-list">
          {resources.map((resource) => {
            const progress = Math.min(100, Math.round((resource.currentAmount / resource.targetAmount) * 100));
            return (
              <article className="resource-card" key={resource.id}>
                <div className="resource-card-main">
                  <div>
                    <strong>{resource.name}</strong>
                    <span>
                      {studyResourceTypeLabel(resource.type)} / {resource.currentAmount}/{resource.targetAmount}{" "}
                      {studyResourceUnitLabel(resource.unit)}
                    </span>
                    <span>
                      期間: {resource.startDate ?? "未設定"} - {resource.endDate ?? "未設定"}
                    </span>
                    <span>開始条件: {formatResourceStartCondition(resource.startCondition, resources)}</span>
                  </div>
                  <div className="resource-actions">
                    <button className="secondary-button" onClick={() => handleEdit(resource)} type="button">
                      編集
                    </button>
                    <button className="secondary-button danger-button" onClick={() => handleDelete(resource.id)} type="button">
                      削除
                    </button>
                  </div>
                </div>
                <div className="bar">
                  <span style={{ width: `${progress}%` }} />
                </div>
                <dl>
                  <div>
                    <dt>現在</dt>
                    <dd>{progress}%</dd>
                  </div>
                  <div>
                    <dt>重要度</dt>
                    <dd>{resource.weight > 0 ? resource.weight : "AI提案"}</dd>
                  </div>
                  <div>
                    <dt>週目標</dt>
                    <dd>{resource.weeklyTarget > 0 ? resource.weeklyTarget : "AI提案"}</dd>
                  </div>
                  <div>
                    <dt>優先度</dt>
                    <dd>{resource.weight > 0 || resource.weeklyTarget > 0 ? priorityLabels[resource.priority] : "AI提案"}</dd>
                  </div>
                </dl>
                {resource.notes && <p>{resource.notes}</p>}
              </article>
            );
          })}
        </div>
      </div>
    </section>
  );
}

function AiStudyPlanView({
  goal,
  anki,
  existingPlan,
  onSave,
  onNotify,
  currentXp,
  xpBreakdown,
}: {
  goal: AppState["goals"][number];
  anki: AppState["anki"];
  existingPlan?: StudyPlan;
  onSave: (plan: StudyPlan) => void;
  onNotify: (message: string) => void;
  currentXp: number;
  xpBreakdown: XpBreakdownItem[];
}) {
  const [memo, setMemo] = useState("");
  const [promptText, setPromptText] = useState("");
  const [copyMessage, setCopyMessage] = useState("");
  const [jsonText, setJsonText] = useState("");
  const [previewPlan, setPreviewPlan] = useState<ImportedStudyPlan | undefined>();
  const [validationErrors, setValidationErrors] = useState<string[]>([]);
  const [validationWarnings, setValidationWarnings] = useState<string[]>([]);
  const [mergeModes, setMergeModes] = useState<Record<string, StudyResourceMergeMode>>({});
  const [activeTab, setActiveTab] = useState<AiPlanTabId>("progress");

  function handlePromptCreate() {
    setPromptText(generateStudyPlanPrompt({ goal, anki, existingPlan, memo, currentXp, xpBreakdown }));
    setCopyMessage("");
  }

  async function handleCopy() {
    if (!promptText) return;

    try {
      await navigator.clipboard.writeText(promptText);
      setCopyMessage("");
      onNotify("コピーしました。");
    } catch {
      setCopyMessage("コピーに失敗しました。テキストを選択してコピーしてください。");
    }
  }

  function handleValidate() {
    const result = validateStudyPlanJson(jsonText, goal, existingPlan);
    setValidationErrors(result.errors);
    setValidationWarnings(result.warnings);
    setPreviewPlan(result.plan);

    if (result.plan) {
      const initialModes = Object.fromEntries(
        result.plan.resources.map((resource) => [
          resource.id,
          existingPlan && findSimilarResource(resource.name, existingPlan.resources) ? "update" : "create",
        ]),
      ) as Record<string, StudyResourceMergeMode>;
      setMergeModes(initialModes);
    }
  }

  function handleConfirm() {
    if (!previewPlan) return;
    const plan = toStudyPlan(previewPlan, goal.id, existingPlan, mergeModes);
    onSave(plan);
    onNotify("学習計画を保存しました。");
  }

  return (
    <section className="ai-plan-layout">
      <div className="ai-plan-tabs" role="tablist" aria-label="AI学習計画の表示切り替え">
        {aiPlanTabs.map((tab) => (
          <button
            aria-selected={activeTab === tab.id}
            className={activeTab === tab.id ? "ai-plan-tab active" : "ai-plan-tab"}
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            role="tab"
            type="button"
          >
            {tab.label}
          </button>
        ))}
      </div>

      {activeTab === "progress" && <CurrentStudyPlan plan={existingPlan} />}

      {activeTab === "update" && (
        <div className="ai-update-grid">
          <div className="panel ai-panel">
            <div className="section-heading">
              <h2>プロンプト生成</h2>
              <p>GoalForgeの現在値をもとに、ChatGPTへ貼り付ける依頼文を作成します。</p>
            </div>
            <label className="field">
              <span>補足メモ</span>
              <textarea
                onChange={(event) => setMemo(event.target.value)}
                placeholder="例: 平日は30分、休日は2時間。リスニングが苦手。"
                value={memo}
              />
            </label>
            <div className="button-row">
              <button className="primary-button" onClick={handlePromptCreate} type="button">
                AI学習計画プロンプトを作成
              </button>
              <button className="secondary-button" disabled={!promptText} onClick={handleCopy} type="button">
                コピー
              </button>
            </div>
            {copyMessage && <p className="success-text">{copyMessage}</p>}
            <label className="field">
              <span>生成プロンプト</span>
              <textarea
                className="prompt-textarea"
                onChange={(event) => setPromptText(event.target.value)}
                placeholder="ボタンを押すとここにプロンプトが表示されます。"
                value={promptText}
              />
            </label>
          </div>

          <div className="panel ai-panel">
            <div className="section-heading">
              <h2>JSONインポート</h2>
              <p>ChatGPTから返ってきたJSONだけを貼り付けてください。</p>
            </div>
            <label className="field">
              <span>AI学習計画JSON</span>
              <textarea
                className="json-textarea"
                onChange={(event) => setJsonText(event.target.value)}
                placeholder='{"goalId":"chuken-2","planName":"...","resources":[...]}'
                value={jsonText}
              />
            </label>
            <button className="primary-button" onClick={handleValidate} type="button">
              取り込み
            </button>
            {!!validationErrors.length && (
              <div className="message-list error">
                {validationErrors.map((error) => (
                  <p key={error}>{error}</p>
                ))}
              </div>
            )}
            {!!validationWarnings.length && (
              <div className="message-list warning">
                {validationWarnings.map((warning) => (
                  <p key={warning}>{warning}</p>
                ))}
              </div>
            )}
            {previewPlan && (
              <PlanPreview
                existingPlan={existingPlan}
                mergeModes={mergeModes}
                onMergeModeChange={(resourceId, mode) =>
                  setMergeModes((current) => ({ ...current, [resourceId]: mode }))
                }
                plan={previewPlan}
              />
            )}
            {previewPlan && (
              <button className="primary-button" onClick={handleConfirm} type="button">
                確定
              </button>
            )}
          </div>
        </div>
      )}

    </section>
  );
}

function PlanPreview({
  plan,
  existingPlan,
  mergeModes,
  onMergeModeChange,
}: {
  plan: ImportedStudyPlan;
  existingPlan?: StudyPlan;
  mergeModes: Record<string, StudyResourceMergeMode>;
  onMergeModeChange: (resourceId: string, mode: StudyResourceMergeMode) => void;
}) {
  return (
    <div className="preview-panel">
      <h3>取り込みプレビュー</h3>
      <p>{plan.overallStrategy || "全体方針なし"}</p>
      <div className="resource-preview-list">
        {plan.resources.map((resource) => {
          const match = existingPlan && findSimilarResource(resource.name, existingPlan.resources);
          return (
            <article className="resource-preview" key={resource.id}>
              <div>
                <strong>{resource.name}</strong>
                <span>
                  {resource.type} / {resource.currentAmount}/{resource.targetAmount}{" "}
                  {studyResourceUnitLabel(resource.unit)} / 重要度 {resource.weight}
                </span>
              </div>
              {match && (
                <label>
                  <span>既存: {match.name}</span>
                  <select
                    onChange={(event) =>
                      onMergeModeChange(resource.id, event.target.value as StudyResourceMergeMode)
                    }
                    value={mergeModes[resource.id] ?? "update"}
                  >
                    <option value="update">上書き</option>
                    <option value="create">新規追加</option>
                  </select>
                </label>
              )}
            </article>
          );
        })}
      </div>
    </div>
  );
}

function CurrentStudyPlan({ plan }: { plan?: StudyPlan }) {
  if (!plan) {
    return (
      <div className="panel ai-panel">
        <h2>現在の学習計画</h2>
        <p>まだ学習計画は取り込まれていません。</p>
      </div>
    );
  }

  const paces = calculateResourcePaces(plan);

  return (
    <div className="panel ai-panel">
      <div className="section-heading">
        <h2>現在の学習計画</h2>
        <p>{plan.planName}</p>
      </div>
      <p>{plan.overallStrategy || "全体方針なし"}</p>
      {plan.xpRecommendation && (
        <div className="xp-recommendation">
          <h3>目標XP提案</h3>
          <dl>
            <div>
              <dt>現在の目標XP</dt>
              <dd>{plan.xpRecommendation.currentTargetXp.toLocaleString()}</dd>
            </div>
            <div>
              <dt>推奨目標XP</dt>
              <dd>{plan.xpRecommendation.recommendedTargetXp.toLocaleString()}</dd>
            </div>
          </dl>
          <p>{plan.xpRecommendation.reason || "理由なし"}</p>
        </div>
      )}
      <StudyPlanCharts plan={plan} paces={paces} />
      <ResourceProgressOverview paces={paces} />
      <PlanSupportingSections plan={plan} />
    </div>
  );
}

function ResourceProgressOverview({ paces }: { paces: ReturnType<typeof calculateResourcePaces> }) {
  return (
    <div className="plan-resource-list">
      {paces.map((pace) => (
        <article className="plan-resource-card" key={pace.resource.id}>
          <div className="plan-resource-header">
            <div>
              <strong>{pace.resource.name}</strong>
              <span>
                {studyResourceTypeLabel(pace.resource.type)} / {pace.resource.currentAmount}/
                {pace.resource.targetAmount} {studyResourceUnitLabel(pace.resource.unit)}
              </span>
              <span>
                {pace.resource.startDate ?? "開始日未設定"} - {pace.resource.endDate ?? "終了日未設定"}
              </span>
            </div>
            <strong className={pace.difference < -10 ? "pace-negative" : "pace-neutral"}>
              {pace.difference > 0 ? "+" : ""}
              {pace.difference}%
            </strong>
          </div>
          <div className="dual-progress">
            <div>
              <span>予定 {pace.scheduledProgress}%</span>
              <div className="bar muted-bar">
                <span style={{ width: `${pace.scheduledProgress}%` }} />
              </div>
            </div>
            <div>
              <span>現在 {pace.currentProgress}%</span>
              <div className="bar">
                <span style={{ width: `${pace.currentProgress}%` }} />
              </div>
            </div>
          </div>
          <dl>
            <div>
              <dt>必要ペース</dt>
              <dd>
                週 {pace.resource.weeklyTarget} {studyResourceUnitLabel(pace.resource.unit)}
              </dd>
            </div>
            <div>
              <dt>重要度</dt>
              <dd>{pace.resource.weight}</dd>
            </div>
            <div>
              <dt>優先度</dt>
              <dd>{priorityLabels[pace.resource.priority]}</dd>
            </div>
            <div>
              <dt>判定</dt>
              <dd>{pace.status}</dd>
            </div>
          </dl>
          <p>開始条件: {formatResourceStartCondition(pace.resource.startCondition, paces.map((item) => item.resource))}</p>
        </article>
      ))}
    </div>
  );
}

function StudyPlanCharts({
  plan,
  paces,
}: {
  plan: StudyPlan;
  paces: ReturnType<typeof calculateResourcePaces>;
}) {
  const ganttItems = buildGanttItems(plan);
  const readiness = calculatePlanReadiness(plan);
  const scheduled = paces[0]?.scheduledProgress ?? 0;
  const expectedPoints = toBurndownPolyline([
    { progress: 0, remaining: 100 },
    { progress: scheduled, remaining: 100 - scheduled },
    { progress: 100, remaining: 0 },
  ]);
  const actualPoints = toBurndownPolyline([
    { progress: 0, remaining: 100 },
    { progress: scheduled, remaining: 100 - readiness },
  ]);

  return (
    <div className="chart-grid">
      <div className="chart-card">
        <div className="section-heading">
          <h3>ガントチャート</h3>
          <p>教材ごとの開始日と終了日をもとに表示しています。</p>
        </div>
        <div className="gantt-chart">
          {ganttItems.map((item) => (
            <div className="gantt-row" key={item.id}>
              <span>{item.name}</span>
              <div className="gantt-track">
                <div
                  className="gantt-bar"
                  style={{ left: `${item.start}%`, width: `${item.width}%` }}
                  title={`${item.startLabel} - ${item.endLabel}`}
                >
                  <i style={{ width: `${item.progress}%` }} />
                </div>
              </div>
              <em>{item.progress}%</em>
            </div>
          ))}
        </div>
      </div>
      <div className="chart-card">
        <div className="section-heading">
          <h3>バーンダウン</h3>
          <p>予定の残り量と、現在進捗から見た残り量を比較します。</p>
        </div>
        <svg className="burndown-chart" role="img" viewBox="0 0 320 150">
          <line className="chart-axis" x1="28" x2="300" y1="122" y2="122" />
          <line className="chart-axis" x1="28" x2="28" y1="20" y2="122" />
          <polyline className="expected-line" points={expectedPoints} />
          <polyline className="actual-line" points={actualPoints} />
          <circle cx={toChartX(scheduled)} cy={toChartY(100 - readiness)} r="4" />
        </svg>
        <div className="chart-legend">
          <span><i className="expected-dot" />予定</span>
          <span><i className="actual-dot" />実際</span>
          <strong>乖離 {readiness - scheduled > 0 ? "+" : ""}{readiness - scheduled}%</strong>
        </div>
      </div>
    </div>
  );
}

function buildGanttItems(plan: StudyPlan) {
  const planStart = new Date(plan.importedAt);
  const planEnd = new Date(`${plan.examDate}T00:00:00`);
  const total = Math.max(1, planEnd.getTime() - planStart.getTime());

  return plan.resources.map((resource) => {
    const startDate = new Date(`${resource.startDate ?? toDateValue(plan.importedAt)}T00:00:00`);
    const endDate = new Date(`${resource.endDate ?? plan.examDate}T00:00:00`);
    const start = Math.min(100, Math.max(0, ((startDate.getTime() - planStart.getTime()) / total) * 100));
    const end = Math.min(100, Math.max(start + 2, ((endDate.getTime() - planStart.getTime()) / total) * 100));
    const progress = Math.min(100, Math.round((resource.currentAmount / resource.targetAmount) * 100));

    return {
      id: resource.id,
      name: resource.name,
      start,
      width: Math.min(100 - start, Math.max(2, end - start)),
      progress,
      startLabel: formatShortDate(startDate),
      endLabel: formatShortDate(endDate),
    };
  });
}

function formatShortDate(value: string | Date) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "日付未設定";
  return new Intl.DateTimeFormat("ja-JP", { month: "2-digit", day: "2-digit" }).format(date);
}

function toChartX(progress: number) {
  return 28 + Math.min(100, Math.max(0, progress)) * 2.72;
}

function toChartY(remaining: number) {
  return 20 + Math.min(100, Math.max(0, remaining)) * 1.02;
}

function toBurndownPolyline(points: Array<{ progress: number; remaining: number }>) {
  return points.map((point) => `${toChartX(point.progress)},${toChartY(point.remaining)}`).join(" ");
}

function PlanSupportingSections({ plan }: { plan: StudyPlan }) {
  return (
    <div className="supporting-grid">
      <div>
        <h3>マイルストーン</h3>
        {plan.milestones.length ? (
          plan.milestones.map((milestone) => (
            <article key={`${milestone.date}-${milestone.title}`}>
              <strong>{milestone.date} {milestone.title}</strong>
              <p>{milestone.description}</p>
            </article>
          ))
        ) : (
          <p>未設定</p>
        )}
      </div>
      <div>
        <h3>注意点</h3>
        {plan.warnings.length ? (
          <ul>
            {plan.warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        ) : (
          <p>未設定</p>
        )}
      </div>
    </div>
  );
}

function PaceView({ plan, readiness }: { plan?: StudyPlan; readiness: number }) {
  if (!plan) {
    return (
      <section className="panel">
        <h2>ペース管理</h2>
        <p>AI学習計画をインポートすると、教材別の予定進捗と現在進捗を比較できます。</p>
      </section>
    );
  }

  const paces = calculateResourcePaces(plan);

  return (
    <section className="pace-layout">
      <div className="panel pace-summary">
        <span>総合の合格準備度</span>
        <strong>{readiness}%</strong>
        <p>XPではなく、教材ごとの現在進捗率と重要度から計算しています。</p>
      </div>
      <div className="panel">
        <h2>教材別進捗</h2>
        <div className="pace-list">
          {paces.map((pace) => (
            <article className="pace-row" key={pace.resource.id}>
              <div>
                <strong>{pace.resource.name}</strong>
                <span>
                  必要ペース: 週 {pace.resource.weeklyTarget} {studyResourceUnitLabel(pace.resource.unit)}
                </span>
              </div>
              <dl>
                <div>
                  <dt>予定</dt>
                  <dd>{pace.scheduledProgress}%</dd>
                </div>
                <div>
                  <dt>現在</dt>
                  <dd>{pace.currentProgress}%</dd>
                </div>
                <div>
                  <dt>差分</dt>
                  <dd>{pace.difference > 0 ? "+" : ""}{pace.difference}%</dd>
                </div>
                <div>
                  <dt>判定</dt>
                  <dd>{pace.status}</dd>
                </div>
              </dl>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}

function SyncView({
  status,
  message,
  anki,
  onSync,
}: {
  status: SyncStatus;
  message: string;
  anki: AppState["anki"];
  onSync: () => void;
}) {
  return (
    <section className="sync-layout">
      <div className="panel sync-main">
        <div className="sync-header">
          <div>
            <h2>AnkiConnect</h2>
            <p>Mac版Ankiが起動している場合、ローカルのAnkiConnectから取得します。</p>
          </div>
          <button className="primary-button" onClick={onSync}>
            Ankiと同期
          </button>
        </div>
        <div className={`sync-message ${status}`}>{message}</div>
        <dl className="stat-grid">
          <div>
            <dt>前回同期日時</dt>
            <dd>{formatDateTime(anki.syncedAt)}</dd>
          </div>
          <div>
            <dt>デッキ数</dt>
            <dd>{anki.deckNames.length}</dd>
          </div>
          <div>
            <dt>対象カード数</dt>
            <dd>{anki.targetDeckCardCount}</dd>
          </div>
          <div>
            <dt>対象デッキの全期間レビュー</dt>
            <dd>{anki.totalReviewCount.toLocaleString()}</dd>
          </div>
          <div>
            <dt>対象デッキの学習済みカード</dt>
            <dd>{anki.totalLearnedCardCount.toLocaleString()}</dd>
          </div>
          <div>
            <dt>タグ数</dt>
            <dd>{anki.tags.length}</dd>
          </div>
        </dl>
      </div>

      <div className="panel data-panel">
        <h2>前回同期データ</h2>
        <div className="data-section">
          <strong>デッキ一覧 ({anki.deckNames.length}件)</strong>
          {anki.deckNames.length ? (
            <ul className="deck-list">
              {anki.deckNames.map((deckName) => (
                <li key={deckName}>{deckName}</li>
              ))}
            </ul>
          ) : (
            <p>未取得</p>
          )}
        </div>
        <div className="data-section">
          <strong>カード・ノート情報</strong>
          <p>
            カード {anki.cardSample.length}件 / ノート {anki.noteSample.length}件を保持
          </p>
        </div>
        <div className="data-section">
          <strong>レビュー履歴</strong>
          <p>{anki.reviewHistory.length}件のカード履歴サンプル</p>
        </div>
      </div>
    </section>
  );
}

function DataManagementView({
  state,
  onImport,
  onNotify,
}: {
  state: AppState;
  onImport: (state: AppState) => void;
  onNotify: (message: string) => void;
}) {
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [databaseInfo, setDatabaseInfo] = useState<{ path: string; schemaVersion: number } | null>(null);
  useEffect(() => {
    void getDatabaseInfo().then(setDatabaseInfo).catch(() => setDatabaseInfo(null));
  }, []);
  const backupSummary = {
    goals: state.goals.length,
    resources: state.studyPlans.reduce((sum, plan) => sum + plan.resources.length, 0),
    activities: state.activities.length,
    plans: state.studyPlans.length,
  };

  function handleExport() {
    const json = createBackupJson(state);
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    const date = new Date().toLocaleDateString("en-CA");

    link.href = url;
    link.download = `goalforge-backup-${date}.json`;
    link.click();
    URL.revokeObjectURL(url);
    onNotify("バックアップJSONをダウンロードしました。");
    setMessage("");
    setError("");
  }

  async function handleImport(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;

    try {
      const text = await file.text();
      const nextState = parseBackupJson(text);
      onImport(nextState);
      onNotify("バックアップJSONを読み込みました。");
      setError("");
      setMessage("");
    } catch {
      setError("バックアップJSONを読み込めませんでした。ファイルの内容を確認してください。");
      setMessage("");
    } finally {
      event.target.value = "";
    }
  }

  return (
    <section className="data-management-layout">
      <div className="panel data-management-panel">
        <div className="section-heading">
          <h2>外部ファイルバックアップ</h2>
          <p>SQLiteに保存された全学習目標のデータをJSONファイルとして保存し、必要なときに復元できます。</p>
        </div>
        <dl className="backup-summary">
          <div>
            <dt>学習目標</dt>
            <dd>{backupSummary.goals}</dd>
          </div>
          <div>
            <dt>教材</dt>
            <dd>{backupSummary.resources}</dd>
          </div>
          <div>
            <dt>学習記録</dt>
            <dd>{backupSummary.activities}</dd>
          </div>
          <div>
            <dt>学習計画</dt>
            <dd>{backupSummary.plans}</dd>
          </div>
        </dl>
        <div className="button-row">
          <button className="primary-button" onClick={handleExport} type="button">
            JSONバックアップを保存
          </button>
          <label className="secondary-button file-button">
            JSONバックアップを読み込む
            <input accept="application/json,.json" onChange={handleImport} type="file" />
          </label>
        </div>
        {message && <p className="success-text">{message}</p>}
        {error && <p className="error-text">{error}</p>}
      </div>
      <div className="panel data-management-panel">
        <h2>保存の扱い</h2>
        <ul className="plain-list">
          <li>通常利用中の学習データはmacOSのApplication Support配下にあるSQLiteへ自動保存します。</li>
          <li>保存先: <code>{databaseInfo?.path ?? "デスクトップ版で確認できます"}</code></li>
          <li>DBスキーマバージョン: {databaseInfo?.schemaVersion ?? "—"}</li>
          <li>LocalStorageには消失しても復元可能なUI設定だけを保存します。</li>
          <li>JSONバックアップは全学習目標をまとめて外部ファイルとして保存します。</li>
          <li>読み込み時は現在のGoalForgeデータ全体をバックアップ内容で置き換えます。</li>
          <li>Safariでも使える方式を優先しているため、任意ファイルへの自動上書き保存は行いません。</li>
        </ul>
      </div>
    </section>
  );
}

function ManualView({
  goalTitle,
  draft,
  summary,
  onChange,
  onSubmit,
}: {
  goalTitle: string;
  draft: ManualEntryDraft;
  summary: { textbookPages: number; exercises: number; correct: number; readAloud: number };
  onChange: (key: keyof ManualEntryDraft, value: string) => void;
  onSubmit: (event: FormEvent) => void;
}) {
  const accuracy = summary.exercises ? Math.round((summary.correct / summary.exercises) * 100) : 0;

  return (
    <section className="manual-layout">
      <form className="panel manual-form" onSubmit={onSubmit}>
        <div className="form-heading">
          <h2>今日の学習を記録</h2>
          <span>記録先: {goalTitle}</span>
        </div>
        <div className="form-grid">
          <NumberField label="テキスト学習ページ数" value={draft.textbookPages} onChange={(value) => onChange("textbookPages", value)} />
          <NumberField label="問題演習数" value={draft.exerciseCount} onChange={(value) => onChange("exerciseCount", value)} />
          <NumberField label="正解数" value={draft.correctCount} onChange={(value) => onChange("correctCount", value)} />
          <NumberField label="模試点数" value={draft.mockExamScore} onChange={(value) => onChange("mockExamScore", value)} />
          <NumberField label="リスニング練習時間" suffix="分" value={draft.listeningMinutes} onChange={(value) => onChange("listeningMinutes", value)} />
          <NumberField label="音読回数" value={draft.readAloudCount} onChange={(value) => onChange("readAloudCount", value)} />
        </div>
        <button className="primary-button" type="submit">
          記録する
        </button>
      </form>
      <aside className="panel today-panel">
        <h2>今日の手入力</h2>
        <dl>
          <div>
            <dt>テキスト</dt>
            <dd>{summary.textbookPages}ページ</dd>
          </div>
          <div>
            <dt>問題</dt>
            <dd>{summary.exercises}問</dd>
          </div>
          <div>
            <dt>正答率</dt>
            <dd>{accuracy}%</dd>
          </div>
          <div>
            <dt>音読</dt>
            <dd>{summary.readAloud}回</dd>
          </div>
        </dl>
      </aside>
    </section>
  );
}

function NumberField({
  label,
  value,
  suffix,
  onChange,
}: {
  label: string;
  value: number;
  suffix?: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      <div>
        <input min="0" type="number" value={value} onChange={(event) => onChange(event.target.value)} />
        {suffix && <em>{suffix}</em>}
      </div>
    </label>
  );
}

function CollectionView({ collections }: { collections: AppState["collections"] }) {
  return (
    <section className="collection-section">
      <p>この画面の進捗は現在サンプルです。Ankiタグや手入力との自動連動は未実装です。</p>
      <div className="collection-grid">
        {collections.map((collection) => {
          const progress = Math.round((collection.collected / collection.total) * 100);
          return (
            <article className="panel collection-card" key={collection.id}>
              <div>
                <h2>{collection.name}</h2>
                <span>Lv.{collection.level}</span>
              </div>
              <strong>{progress}%</strong>
              <div className="bar">
                <span style={{ width: `${progress}%` }} />
              </div>
              <p>
                {collection.collected}/{collection.total} 項目
              </p>
            </article>
          );
        })}
      </div>
    </section>
  );
}

function UnlockView({
  cities,
  currentXp,
  level,
}: {
  cities: AppState["cityRewards"];
  currentXp: number;
  level: number;
}) {
  return (
    <section className="unlock-layout">
      <div className="panel passport">
        <span>Study Passport</span>
        <strong>Lv.{level}</strong>
        <p>{currentXp.toLocaleString()} XP</p>
      </div>
      <div className="city-list">
        {cities.map((city) => {
          const unlocked = currentXp >= city.requiredXp;
          return (
            <article className={unlocked ? "panel city-card unlocked" : "panel city-card"} key={city.id}>
              <div className="city-stamp">{unlocked ? "OPEN" : "LOCK"}</div>
              <div>
                <h2>{city.city}</h2>
                <span>{city.requiredXp}XPで解放</span>
                <p>{city.description}</p>
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}

export default App;
