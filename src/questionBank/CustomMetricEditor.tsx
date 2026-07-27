import React, { useEffect, useMemo, useState } from "react";
import type {
  AttemptField,
  AttemptPredicate,
  ComparisonOperator,
  CustomMetricDefinitionDto,
} from "./customMetrics";
import {
  createCustomMetricDraft,
  customMetricDraftEquals,
  customMetricDraftToWriteInput,
  defaultPredicateForField,
  operatorsForField,
  predicateWithOperator,
  summarizeCustomMetricDraft,
  type CustomMetricDraft,
  validateCustomMetricDraft,
} from "./customMetricEditorModel";
import type { CustomMetricSettingsRepository } from "./CustomMetricSettingsPanel";
import { toMessage } from "./QuestionBankView";

const attemptFieldLabels: Record<AttemptField, string> = {
  result: "解答",
  confidence: "確信度",
  attempt_number: "解答回数",
  round_id: "周回ID",
  round_number: "周回番号",
  answered_at: "解答日時",
};

const operatorLabels: Record<ComparisonOperator, string> = {
  eq: "等しい",
  neq: "等しくない",
  gte: "以上",
  lte: "以下",
  between: "範囲内",
  is_null: "値なし",
  is_not_null: "値あり",
};

export async function saveCustomMetricDraft(
  repository: CustomMetricSettingsRepository,
  questionBankId: string,
  metric: CustomMetricDefinitionDto | null,
  draft: CustomMetricDraft,
): Promise<CustomMetricDefinitionDto> {
  const validation = validateCustomMetricDraft(draft);
  if (!validation.valid) throw new Error(validation.errors.join("\n"));
  const input = customMetricDraftToWriteInput(draft);
  return metric
    ? repository.updateCustomMetric(metric.metricId, input)
    : repository.createCustomMetric(questionBankId, input);
}

export function requestDiscardCustomMetricChanges(
  dirty: boolean,
  confirmDiscard: () => boolean,
): boolean {
  return !dirty || confirmDiscard();
}

export function MetricBasicFields({
  draft,
  onChange,
}: {
  draft: CustomMetricDraft;
  onChange: (draft: CustomMetricDraft) => void;
}) {
  return (
    <fieldset className="metric-editor-section">
      <legend>基本設定</legend>
      <label>名前
        <input
          autoFocus
          value={draft.name}
          onChange={(event) => onChange({ ...draft, name: event.target.value })}
          required
        />
      </label>
      <label>アイコン（任意）
        <input
          value={draft.icon}
          maxLength={8}
          onChange={(event) => onChange({ ...draft, icon: event.target.value })}
          placeholder="例: ○"
        />
      </label>
      <label className="check-label">
        <input
          type="checkbox"
          checked={draft.isVisible}
          onChange={(event) => onChange({ ...draft, isVisible: event.target.checked })}
        />
        一覧に表示する
      </label>
    </fieldset>
  );
}

export function BooleanGroupEditor({
  predicates,
  onChange,
}: {
  predicates: AttemptPredicate[];
  onChange: (predicates: AttemptPredicate[]) => void;
}) {
  return (
    <div className="boolean-group-editor">
      <p className="helper-text"><strong>すべてANDで判定</strong></p>
      {predicates.map((predicate, index) => (
        <div className="metric-predicate-row" key={index}>
          <select
            aria-label={`条件${index + 1}の項目`}
            value={predicate.field}
            onChange={(event) => {
              const next = [...predicates];
              next[index] = defaultPredicateForField(event.target.value as AttemptField);
              onChange(next);
            }}
          >
            {Object.entries(attemptFieldLabels).map(([value, label]) => (
              <option key={value} value={value}>{label}</option>
            ))}
          </select>
          <select
            aria-label={`条件${index + 1}の比較`}
            value={predicate.operator}
            onChange={(event) => {
              const next = [...predicates];
              next[index] = predicateWithOperator(
                predicate,
                event.target.value as ComparisonOperator,
              );
              onChange(next);
            }}
          >
            {operatorsForField(predicate.field).map((operator) => (
              <option key={operator} value={operator}>{operatorLabels[operator]}</option>
            ))}
          </select>
          <PredicateValueEditor
            predicate={predicate}
            onChange={(nextPredicate) => {
              const next = [...predicates];
              next[index] = nextPredicate;
              onChange(next);
            }}
          />
          <button
            type="button"
            className="danger-button"
            aria-label={`条件${index + 1}を削除`}
            onClick={() => onChange(predicates.filter((_, itemIndex) => itemIndex !== index))}
          >削除</button>
        </div>
      ))}
      <button
        type="button"
        onClick={() => onChange([...predicates, defaultPredicateForField("result")])}
      >条件を追加</button>
    </div>
  );
}

function PredicateValueEditor({
  predicate,
  onChange,
}: {
  predicate: AttemptPredicate;
  onChange: (predicate: AttemptPredicate) => void;
}) {
  if (predicate.operator === "is_null" || predicate.operator === "is_not_null") {
    return <span className="helper-text">値の指定なし</span>;
  }
  if (predicate.field === "result" || predicate.field === "confidence") {
    const options = predicate.field === "result"
      ? [["correct", "正解"], ["partial", "部分正解"], ["incorrect", "不正解"]]
      : [["high", "高"], ["medium", "中"], ["low", "低"]];
    return (
      <select
        aria-label={`${attemptFieldLabels[predicate.field]}の値`}
        value={String(predicate.value)}
        onChange={(event) => onChange({ ...predicate, value: event.target.value })}
      >
        {options.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
      </select>
    );
  }
  if (predicate.operator === "between" && Array.isArray(predicate.value)) {
    const range = predicate.value as readonly [string | number, string | number];
    const updateRange = (
      start: string | number,
      end: string | number,
    ): readonly [number, number] | readonly [string, string] => (
      predicate.field === "answered_at"
        ? [String(start), String(end)]
        : [Number(start), Number(end)]
    );
    return (
      <span className="metric-between-values">
        <PredicateScalarInput
          field={predicate.field}
          value={range[0]}
          onChange={(value) => onChange({
            ...predicate,
            value: updateRange(value, range[1]),
          })}
        />
        〜
        <PredicateScalarInput
          field={predicate.field}
          value={range[1]}
          onChange={(value) => onChange({
            ...predicate,
            value: updateRange(range[0], value),
          })}
        />
      </span>
    );
  }
  return (
    <PredicateScalarInput
      field={predicate.field}
      value={predicate.value as string | number}
      onChange={(value) => onChange({ ...predicate, value })}
    />
  );
}

function PredicateScalarInput({
  field,
  value,
  onChange,
}: {
  field: AttemptField;
  value: string | number;
  onChange: (value: string | number) => void;
}) {
  if (field === "attempt_number" || field === "round_number") {
    return (
      <input
        type="number"
        min={1}
        value={Number(value)}
        onChange={(event) => onChange(event.target.valueAsNumber)}
      />
    );
  }
  if (field === "answered_at") {
    const dateValue = typeof value === "string" && !Number.isNaN(Date.parse(value))
      ? new Date(value).toISOString().slice(0, 16)
      : "";
    return (
      <input
        type="datetime-local"
        value={dateValue}
        onChange={(event) => onChange(new Date(event.target.value).toISOString())}
      />
    );
  }
  return <input value={String(value)} onChange={(event) => onChange(event.target.value)} />;
}

export function MetricDefinitionEditor({
  draft,
  onChange,
}: {
  draft: CustomMetricDraft;
  onChange: (draft: CustomMetricDraft) => void;
}) {
  const clause = draft.definition.clauses[0];
  const updateClause = (changes: Partial<typeof clause>) => onChange({
    ...draft,
    definition: {
      ...draft.definition,
      clauses: [{ ...clause, ...changes }],
    },
  });
  return (
    <fieldset className="metric-editor-section">
      <legend>達成条件</legend>
      <label>対象Attempt
        <select
          value={clause.attemptScope}
          onChange={(event) => updateClause({
            attemptScope: event.target.value as typeof clause.attemptScope,
          })}
        >
          <option value="all">全Attempt</option>
          <option value="latest">最新Attemptのみ</option>
          <option value="except_latest">最新Attempt以外</option>
        </select>
      </label>
      <BooleanGroupEditor
        predicates={clause.where.clauses}
        onChange={(clauses) => updateClause({
          where: { operator: "and", clauses },
        })}
      />
      <div className="metric-count-editor">
        <label>回数条件
          <select
            value={clause.count.operator}
            onChange={(event) => updateClause({
              count: {
                ...clause.count,
                operator: event.target.value as typeof clause.count.operator,
              },
            })}
          >
            <option value="gte">以上</option>
            <option value="eq">ちょうど</option>
            <option value="lte">以下</option>
          </select>
        </label>
        <label>回数
          <input
            type="number"
            min={0}
            value={clause.count.value}
            onChange={(event) => updateClause({
              count: { ...clause.count, value: event.target.valueAsNumber },
            })}
          />
        </label>
      </div>
    </fieldset>
  );
}

export function ConditionSummaryPreview({ draft }: { draft: CustomMetricDraft }) {
  return (
    <section className="condition-summary-preview" aria-live="polite">
      <h3>条件プレビュー</h3>
      <p>{summarizeCustomMetricDraft(draft)}</p>
    </section>
  );
}

export function PopulationEditor() {
  return (
    <fieldset className="metric-editor-section" disabled>
      <legend>集計対象</legend>
      <p>除外状態ではない、この教材の全問題</p>
      <p className="helper-text">Version 1では集計対象を変更できません。</p>
    </fieldset>
  );
}

export function CustomMetricEditor({
  draft,
  onChange,
}: {
  draft: CustomMetricDraft;
  onChange: (draft: CustomMetricDraft) => void;
}) {
  return (
    <>
      <MetricBasicFields draft={draft} onChange={onChange} />
      <MetricDefinitionEditor draft={draft} onChange={onChange} />
      <ConditionSummaryPreview draft={draft} />
      <PopulationEditor />
    </>
  );
}

export function CustomMetricEditorDialog({
  questionBankId,
  metric,
  repository,
  onSaved,
  onDelete,
  onRequestClose,
  onDirtyChange,
}: {
  questionBankId: string;
  metric: CustomMetricDefinitionDto | null;
  repository: CustomMetricSettingsRepository;
  onSaved: (metric: CustomMetricDefinitionDto) => Promise<void>;
  onDelete: (metric: CustomMetricDefinitionDto) => Promise<void>;
  onRequestClose: () => void;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const initialDraft = useMemo(() => createCustomMetricDraft(metric ?? undefined), [metric]);
  const [draft, setDraft] = useState(initialDraft);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const validation = useMemo(() => validateCustomMetricDraft(draft), [draft]);
  const dirty = useMemo(
    () => !customMetricDraftEquals(draft, initialDraft),
    [draft, initialDraft],
  );

  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange(false), [onDirtyChange]);

  const tryClose = () => {
    if (requestDiscardCustomMetricChanges(
      dirty,
      () => window.confirm("未保存の変更があります。破棄して閉じますか？"),
    )) {
      onRequestClose();
    }
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        tryClose();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const latestValidation = validateCustomMetricDraft(draft);
    if (!latestValidation.valid) {
      setError(latestValidation.errors.join(" "));
      return;
    }
    setSaving(true);
    setError("");
    try {
      const saved = await saveCustomMetricDraft(repository, questionBankId, metric, draft);
      await onSaved(saved);
    } catch (reason) {
      setError(toMessage(reason));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      className="history-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) tryClose();
      }}
    >
      <form
        className="modal-panel custom-metric-editor-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="custom-metric-editor-title"
        onSubmit={submit}
      >
        <button className="dialog-close" type="button" onClick={tryClose}>閉じる</button>
        <h2 id="custom-metric-editor-title">
          {metric ? "カスタムメトリクスを編集" : "カスタムメトリクスを作成"}
        </h2>
        <CustomMetricEditor draft={draft} onChange={setDraft} />
        {!validation.valid && (
          <ul className="form-error metric-validation-errors">
            {validation.errors.map((message) => <li key={message}>{message}</li>)}
          </ul>
        )}
        {error && <p className="form-error" role="alert">{error}</p>}
        <div className="modal-actions">
          {metric && (
            <button
              type="button"
              className="danger-button"
              onClick={() => void onDelete(metric)}
            >削除</button>
          )}
          <button type="button" onClick={tryClose}>キャンセル</button>
          <button className="primary-button" disabled={saving || !validation.valid}>
            {saving ? "保存中…" : "保存"}
          </button>
        </div>
      </form>
    </div>
  );
}
