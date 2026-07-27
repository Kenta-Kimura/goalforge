import React, { useCallback, useEffect, useMemo, useState } from "react";
import { CustomMetricEditorDialog } from "./CustomMetricEditor";
import { notifyCustomMetricsChanged } from "./customMetricEvents";
import type { CustomMetricDefinitionDto } from "./customMetrics";
import { DEFAULT_CUSTOM_METRIC_TEMPLATES } from "./customMetrics";
import {
  SqliteQuestionBankRepository,
  type QuestionBankRepository,
} from "./repository";
import { toMessage } from "./QuestionBankView";

const defaultRepository = new SqliteQuestionBankRepository();
const noop = () => undefined;

export type CustomMetricSettingsRepository = Pick<
  QuestionBankRepository,
  | "listCustomMetrics"
  | "createCustomMetric"
  | "updateCustomMetric"
  | "setCustomMetricVisibility"
  | "moveCustomMetric"
  | "deleteCustomMetric"
  | "resetCustomMetrics"
  | "restoreDefaultCustomMetric"
>;

export interface CustomMetricSettingsState {
  metrics: CustomMetricDefinitionDto[];
  loading: boolean;
  error: string;
  moving: string | null;
  deleting: string | null;
  restoring: string | null;
  resetting: boolean;
}

export interface CustomMetricSettingsActions {
  reload: () => Promise<void>;
  setVisibility: (metric: CustomMetricDefinitionDto, isVisible: boolean) => Promise<void>;
  move: (metric: CustomMetricDefinitionDto, newSortOrder: number) => Promise<void>;
  deleteMetric: (metric: CustomMetricDefinitionDto) => Promise<void>;
  restoreDefault: (systemKey: string) => Promise<void>;
  resetAll: () => Promise<void>;
}

export function sortCustomMetrics(
  metrics: CustomMetricDefinitionDto[],
): CustomMetricDefinitionDto[] {
  return [...metrics].sort(
    (left, right) => left.sortOrder - right.sortOrder || left.metricId.localeCompare(right.metricId),
  );
}

export async function loadCustomMetricSettings(
  repository: CustomMetricSettingsRepository,
  questionBankId: string,
): Promise<CustomMetricDefinitionDto[]> {
  return sortCustomMetrics(await repository.listCustomMetrics(questionBankId));
}

export async function changeCustomMetricVisibility(
  repository: CustomMetricSettingsRepository,
  metric: CustomMetricDefinitionDto,
  isVisible: boolean,
): Promise<CustomMetricDefinitionDto> {
  return repository.setCustomMetricVisibility(metric.metricId, isVisible);
}

export async function moveCustomMetricSetting(
  repository: CustomMetricSettingsRepository,
  metric: CustomMetricDefinitionDto,
  newSortOrder: number,
): Promise<CustomMetricDefinitionDto[]> {
  return sortCustomMetrics(await repository.moveCustomMetric(metric.metricId, newSortOrder));
}

export async function restoreCustomMetricDefault(
  repository: CustomMetricSettingsRepository,
  questionBankId: string,
  systemKey: string,
): Promise<CustomMetricDefinitionDto[]> {
  await repository.restoreDefaultCustomMetric(questionBankId, systemKey);
  return loadCustomMetricSettings(repository, questionBankId);
}

export async function deleteCustomMetricAndReload(
  repository: CustomMetricSettingsRepository,
  questionBankId: string,
  metricId: string,
): Promise<CustomMetricDefinitionDto[]> {
  await repository.deleteCustomMetric(metricId);
  return loadCustomMetricSettings(repository, questionBankId);
}

export async function resetCustomMetricsAndReload(
  repository: CustomMetricSettingsRepository,
  questionBankId: string,
): Promise<CustomMetricDefinitionDto[]> {
  await repository.resetCustomMetrics(questionBankId);
  return loadCustomMetricSettings(repository, questionBankId);
}

export function useCustomMetricSettings(
  questionBankId: string,
  repository: CustomMetricSettingsRepository,
  onNotify: (message: string) => void,
): CustomMetricSettingsState & CustomMetricSettingsActions {
  const [metrics, setMetrics] = useState<CustomMetricDefinitionDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [moving, setMoving] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [restoring, setRestoring] = useState<string | null>(null);
  const [resetting, setResetting] = useState(false);

  const reload = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      setMetrics(await loadCustomMetricSettings(repository, questionBankId));
    } catch (reason) {
      setError(toMessage(reason));
    } finally {
      setLoading(false);
    }
  }, [questionBankId, repository]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const setVisibility = useCallback(async (
    metric: CustomMetricDefinitionDto,
    isVisible: boolean,
  ) => {
    setError("");
    setMetrics((current) => current.map((item) => (
      item.metricId === metric.metricId ? { ...item, isVisible } : item
    )));
    try {
      const updated = await changeCustomMetricVisibility(repository, metric, isVisible);
      setMetrics((current) => sortCustomMetrics(current.map((item) => (
        item.metricId === updated.metricId ? updated : item
      ))));
      notifyCustomMetricsChanged(questionBankId);
    } catch (reason) {
      setMetrics((current) => current.map((item) => (
        item.metricId === metric.metricId ? { ...item, isVisible: metric.isVisible } : item
      )));
      const message = `表示設定を更新できませんでした: ${toMessage(reason)}`;
      setError(message);
      onNotify(message);
    }
  }, [onNotify, questionBankId, repository]);

  const move = useCallback(async (
    metric: CustomMetricDefinitionDto,
    newSortOrder: number,
  ) => {
    setMoving(metric.metricId);
    try {
      setMetrics(await moveCustomMetricSetting(repository, metric, newSortOrder));
      notifyCustomMetricsChanged(questionBankId);
    } catch (reason) {
      onNotify(`並び順を更新できませんでした: ${toMessage(reason)}`);
    } finally {
      setMoving(null);
    }
  }, [onNotify, questionBankId, repository]);

  const deleteMetric = useCallback(async (metric: CustomMetricDefinitionDto) => {
    setDeleting(metric.metricId);
    try {
      setMetrics(await deleteCustomMetricAndReload(repository, questionBankId, metric.metricId));
      notifyCustomMetricsChanged(questionBankId);
      onNotify("カスタムメトリクスを削除しました。");
    } finally {
      setDeleting(null);
    }
  }, [onNotify, questionBankId, repository]);

  const restoreDefault = useCallback(async (systemKey: string) => {
    setRestoring(systemKey);
    try {
      setMetrics(await restoreCustomMetricDefault(repository, questionBankId, systemKey));
      notifyCustomMetricsChanged(questionBankId);
      onNotify("デフォルトメトリクスを復元しました。");
    } catch (reason) {
      onNotify(`復元できませんでした: ${toMessage(reason)}`);
    } finally {
      setRestoring(null);
    }
  }, [onNotify, questionBankId, repository]);

  const resetAll = useCallback(async () => {
    setResetting(true);
    try {
      setMetrics(await resetCustomMetricsAndReload(repository, questionBankId));
      notifyCustomMetricsChanged(questionBankId);
      onNotify("カスタムメトリクスを初期状態へ戻しました");
    } finally {
      setResetting(false);
    }
  }, [onNotify, questionBankId, repository]);

  return {
    metrics,
    loading,
    error,
    moving,
    deleting,
    restoring,
    resetting,
    reload,
    setVisibility,
    move,
    deleteMetric,
    restoreDefault,
    resetAll,
  };
}

interface CustomMetricSettingsContentProps extends CustomMetricSettingsState {
  onReload: () => void;
  onVisibilityChange: (metric: CustomMetricDefinitionDto, isVisible: boolean) => void;
  onMove: (metric: CustomMetricDefinitionDto, newSortOrder: number) => void;
  onDelete: (metric: CustomMetricDefinitionDto) => void;
  onRestore: (systemKey: string) => void;
  onCreate: () => void;
  onEdit: (metric: CustomMetricDefinitionDto) => void;
  onReset: () => void;
}

export function CustomMetricSettingsContent({
  metrics,
  loading,
  error,
  moving,
  deleting,
  restoring,
  onReload,
  onVisibilityChange,
  onMove,
  onDelete,
  onRestore,
  onCreate,
  onEdit,
  onReset,
}: CustomMetricSettingsContentProps) {
  const missingDefaults = DEFAULT_CUSTOM_METRIC_TEMPLATES.filter((template) => (
    !metrics.some((metric) => metric.systemKey === template.systemKey)
  ));

  return (
    <section className="panel custom-metric-settings" aria-labelledby="custom-metric-settings-title">
      <div className="panel-heading">
        <div>
          <span className="eyebrow">Question Bankごとの集計条件</span>
          <h3 id="custom-metric-settings-title">カスタムメトリクス</h3>
          <p className="helper-text">演習一覧に表示する達成条件と並び順を管理します。</p>
        </div>
        <button type="button" className="primary-button" onClick={onCreate}>
          新しいメトリクス
        </button>
      </div>

      {loading && (
        <div className="custom-metric-skeleton" aria-label="カスタムメトリクスを読み込んでいます">
          <span /><span /><span />
        </div>
      )}

      {!loading && error && (
        <div className="custom-metric-error" role="alert">
          <p>{error}</p>
          <button type="button" onClick={onReload}>再読み込み</button>
        </div>
      )}

      {!loading && !error && metrics.length === 0 && (
        <div className="empty-state custom-metric-empty">
          <h4>メトリクスがありません</h4>
          <p>削除したデフォルトメトリクスは下から復元できます。</p>
        </div>
      )}

      {!loading && !error && metrics.length > 0 && (
        <ul className="custom-metric-list">
          {metrics.map((metric, index) => {
            const busy = moving === metric.metricId || deleting === metric.metricId;
            return (
              <li className="custom-metric-row" key={metric.metricId}>
                <span className="custom-metric-icon" aria-hidden="true">{metric.icon || "—"}</span>
                <div className="custom-metric-name">
                  <strong>{metric.name}</strong>
                  <span className={`metric-origin-badge ${metric.origin}`}>
                    {metric.origin === "default" ? "Default" : "Custom"}
                  </span>
                </div>
                <label className="custom-metric-visibility">
                  <input
                    type="checkbox"
                    role="switch"
                    aria-label={`${metric.name}を表示`}
                    checked={metric.isVisible}
                    disabled={busy}
                    onChange={(event) => onVisibilityChange(metric, event.target.checked)}
                  />
                  <span>{metric.isVisible ? "表示" : "非表示"}</span>
                </label>
                <div className="custom-metric-order" aria-label={`${metric.name}の並び替え`}>
                  <button
                    type="button"
                    aria-label={`${metric.name}を上へ`}
                    disabled={busy || index === 0}
                    onClick={() => onMove(metric, index - 1)}
                  >↑</button>
                  <button
                    type="button"
                    aria-label={`${metric.name}を下へ`}
                    disabled={busy || index === metrics.length - 1}
                    onClick={() => onMove(metric, index + 1)}
                  >↓</button>
                </div>
                <button type="button" onClick={() => onEdit(metric)}>編集</button>
                <details className="custom-metric-menu">
                  <summary>操作</summary>
                  <button
                    type="button"
                    className="danger-button"
                    disabled={busy}
                    onClick={() => onDelete(metric)}
                  >{deleting === metric.metricId ? "削除中…" : "削除"}</button>
                </details>
              </li>
            );
          })}
        </ul>
      )}

      {missingDefaults.length > 0 && !loading && !error && (
        <div className="custom-metric-restore">
          <h4>利用していないデフォルトメトリクス</h4>
          {missingDefaults.map((template) => (
            <div key={template.systemKey}>
              <span aria-hidden="true">{template.icon}</span>
              <span>{template.name}</span>
              <button
                type="button"
                disabled={restoring === template.systemKey}
                onClick={() => onRestore(template.systemKey)}
              >{restoring === template.systemKey ? "復元中…" : "復元"}</button>
            </div>
          ))}
        </div>
      )}
      {!loading && !error && (
        <div className="custom-metric-reset-action">
          <button type="button" className="warning-button" onClick={onReset}>
            カスタムメトリクスを初期状態に戻す
          </button>
        </div>
      )}
    </section>
  );
}

export function CustomMetricSettingsPanel({
  questionBankId,
  repository = defaultRepository,
  onNotify = noop,
  onEditorDirtyChange = noop,
}: {
  questionBankId: string;
  repository?: CustomMetricSettingsRepository;
  onNotify?: (message: string) => void;
  onEditorDirtyChange?: (dirty: boolean) => void;
}) {
  const stableNotify = useCallback(onNotify, [onNotify]);
  const settings = useCustomMetricSettings(questionBankId, repository, stableNotify);
  const [editingMetric, setEditingMetric] = useState<
    CustomMetricDefinitionDto | null | undefined
  >(undefined);
  const [deleteRequest, setDeleteRequest] = useState<{
    metric: CustomMetricDefinitionDto;
    closeEditorAfterDelete: boolean;
  } | null>(null);
  const [resetRequested, setResetRequested] = useState(false);
  useEffect(() => {
    setEditingMetric(undefined);
    onEditorDirtyChange(false);
  }, [onEditorDirtyChange, questionBankId]);
  const contentState = useMemo(() => ({
    metrics: settings.metrics,
    loading: settings.loading,
    error: settings.error,
    moving: settings.moving,
    deleting: settings.deleting,
    restoring: settings.restoring,
    resetting: settings.resetting,
  }), [
    settings.deleting,
    settings.error,
    settings.loading,
    settings.metrics,
    settings.moving,
    settings.restoring,
    settings.resetting,
  ]);

  return (
    <>
    <CustomMetricSettingsContent
      {...contentState}
      onReload={() => void settings.reload()}
      onVisibilityChange={(metric, isVisible) => void settings.setVisibility(metric, isVisible)}
      onMove={(metric, sortOrder) => void settings.move(metric, sortOrder)}
      onDelete={(metric) => setDeleteRequest({
        metric,
        closeEditorAfterDelete: false,
      })}
      onRestore={(systemKey) => void settings.restoreDefault(systemKey)}
      onCreate={() => setEditingMetric(null)}
      onEdit={setEditingMetric}
      onReset={() => setResetRequested(true)}
    />
    {editingMetric !== undefined && (
      <CustomMetricEditorDialog
        questionBankId={questionBankId}
        metric={editingMetric}
        repository={repository}
        onDirtyChange={onEditorDirtyChange}
        onRequestClose={() => setEditingMetric(undefined)}
        onSaved={async () => {
          await settings.reload();
          notifyCustomMetricsChanged(questionBankId);
          setEditingMetric(undefined);
          onEditorDirtyChange(false);
          onNotify(editingMetric ? "カスタムメトリクスを更新しました。" : "カスタムメトリクスを作成しました。");
        }}
        onDelete={async (metric) => {
          setDeleteRequest({
            metric,
            closeEditorAfterDelete: true,
          });
        }}
      />
    )}
    {deleteRequest && (
      <CustomMetricDeleteDialog
        metric={deleteRequest.metric}
        deleting={settings.deleting === deleteRequest.metric.metricId}
        onCancel={() => setDeleteRequest(null)}
        onConfirm={async () => {
          await settings.deleteMetric(deleteRequest.metric);
          const closeEditor = deleteRequest.closeEditorAfterDelete;
          setDeleteRequest(null);
          if (closeEditor) {
            setEditingMetric(undefined);
            onEditorDirtyChange(false);
          }
        }}
      />
    )}
    {resetRequested && (
      <CustomMetricResetDialog
        resetting={settings.resetting}
        onCancel={() => setResetRequested(false)}
        onConfirm={async () => {
          await settings.resetAll();
          setResetRequested(false);
        }}
      />
    )}
    </>
  );
}

export function CustomMetricDeleteDialog({
  metric,
  deleting,
  onCancel,
  onConfirm,
}: {
  metric: CustomMetricDefinitionDto;
  deleting: boolean;
  onCancel: () => void;
  onConfirm: () => Promise<void>;
}) {
  const [error, setError] = useState("");
  return (
    <div
      className="history-backdrop custom-metric-delete-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !deleting) onCancel();
      }}
    >
      <section
        className="modal-panel"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="custom-metric-delete-title"
      >
        <h2 id="custom-metric-delete-title">メトリクスを削除しますか？</h2>
        <p>「{metric.name}」を一覧から削除します。</p>
        {metric.origin === "default" ? (
          <p className="helper-text">
            デフォルトメトリクスは削除後、「利用していないデフォルトメトリクス」から復元できます。
          </p>
        ) : (
          <p className="delete-warning">カスタムメトリクスは設定画面から非表示になります。</p>
        )}
        {error && <p className="form-error" role="alert">{error}</p>}
        <div className="modal-actions">
          <button type="button" disabled={deleting} onClick={onCancel}>キャンセル</button>
          <button
            type="button"
            className="danger-button"
            disabled={deleting}
            onClick={async () => {
              setError("");
              try {
                await onConfirm();
              } catch (reason) {
                setError(`削除できませんでした: ${toMessage(reason)}`);
              }
            }}
          >{deleting ? "削除中…" : "削除する"}</button>
        </div>
      </section>
    </div>
  );
}

export function CustomMetricResetDialog({
  resetting,
  onCancel,
  onConfirm,
}: {
  resetting: boolean;
  onCancel: () => void;
  onConfirm: () => Promise<void>;
}) {
  const [error, setError] = useState("");
  return (
    <div
      className="history-backdrop custom-metric-delete-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !resetting) onCancel();
      }}
    >
      <section
        className="modal-panel"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="custom-metric-reset-title"
      >
        <h2 id="custom-metric-reset-title">カスタムメトリクスを初期状態に戻しますか？</h2>
        <p>この操作を実行すると</p>
        <ul>
          <li>デフォルトメトリクスは初期状態へ戻ります</li>
          <li>削除したデフォルトメトリクスは復元されます</li>
          <li>作成したカスタムメトリクスはすべて削除されます</li>
        </ul>
        <p className="delete-warning">この操作は元に戻せません。</p>
        {error && <p className="form-error" role="alert">{error}</p>}
        <div className="modal-actions">
          <button type="button" disabled={resetting} onClick={onCancel}>キャンセル</button>
          <button
            type="button"
            className="warning-button"
            disabled={resetting}
            onClick={async () => {
              setError("");
              try {
                await onConfirm();
              } catch (reason) {
                setError(`初期状態へ戻せませんでした: ${toMessage(reason)}`);
              }
            }}
          >{resetting ? "処理中…" : "初期状態へ戻す"}</button>
        </div>
      </section>
    </div>
  );
}
