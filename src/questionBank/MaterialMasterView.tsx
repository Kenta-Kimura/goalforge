import { FormEvent, useEffect, useMemo, useState } from "react";
import { isTauriRuntime } from "../lib/tauri";
import type { Goal, StudyPlan } from "../types";
import { CustomMetricSettingsPanel } from "./CustomMetricSettingsPanel";
import {
  DeleteProblemPanel,
  ModalBackdrop,
  ProblemEditPanel,
  toMessage,
} from "./QuestionBankView";
import { SqliteQuestionBankRepository } from "./repository";
import { QuestionBankService } from "./service";
import { buildLearningHistoryExport } from "./learningHistoryExport";
import type { EvaluationType, Problem, QuestionBank, QuestionSection } from "./types";

const service = new QuestionBankService(new SqliteQuestionBankRepository());

const evaluationLabels: Record<EvaluationType, string> = {
  binary: "正誤",
  partial_score: "部分点",
  mixed: "混在",
};

export function MaterialMasterView({
  goalId,
  goal,
  studyPlan,
  onNotify = () => undefined,
}: {
  goalId: string;
  goal: Goal;
  studyPlan?: StudyPlan;
  onNotify?: (message: string) => void;
}) {
  const [materials, setMaterials] = useState<QuestionBank[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(isTauriRuntime());
  const [editingProblem, setEditingProblem] = useState<Problem | null>(null);
  const [deletingProblem, setDeletingProblem] = useState<Problem | null>(null);
  const [editingSection, setEditingSection] = useState<QuestionSection | null>(null);
  const [deletingSection, setDeletingSection] = useState<QuestionSection | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [deletingMaterial, setDeletingMaterial] = useState(false);
  const [customMetricEditorDirty, setCustomMetricEditorDirty] = useState(false);

  async function refresh(preferredId?: string) {
    try {
      const next = await service.list();
      setMaterials(next);
      setSelectedId((current) => preferredId || (next.some((item) => item.id === current) ? current : next[0]?.id || ""));
    } catch (error) {
      setMessage(toMessage(error));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (isTauriRuntime()) void refresh();
  }, []);

  const material = materials.find((item) => item.id === selectedId);
  const problemCount = useMemo(
    () => material?.sections.reduce((sum, section) => sum + section.problems.length, 0) ?? 0,
    [material],
  );

  async function run(action: () => Promise<unknown>, success: string, preferredId?: string) {
    try {
      setMessage("");
      await action();
      await refresh(preferredId);
      setMessage(success);
    } catch (error) {
      setMessage(toMessage(error));
    }
  }

  async function exportLearningHistory(material: QuestionBank) {
    try {
      const json = JSON.stringify(buildLearningHistoryExport(material, goal, studyPlan), null, 2);
      await navigator.clipboard.writeText(json);
      setMessage("ChatGPT分析用の学習履歴JSONをクリップボードへコピーしました。");
    } catch (error) {
      setMessage(`学習履歴をエクスポートできませんでした: ${toMessage(error)}`);
    }
  }

  if (!isTauriRuntime()) {
    return <div className="panel desktop-required"><h2>教材管理はデスクトップ版で利用します</h2><p>教材マスターをSQLiteへ保存するため、Tauri版で利用してください。</p></div>;
  }

  return (
    <section className="question-bank-layout material-master">
      {message && <div className="question-message" role="status">{message}</div>}
      <div className="panel question-bank-toolbar">
        <div>
          <span className="eyebrow">唯一のマスターデータ</span>
          <h2>教材管理</h2>
          <p>教材・セクション・問題の構造だけを管理します。解答や周回は「演習」で記録します。</p>
        </div>
        <MaterialCreateForm onCreate={async (title) => {
          const created = await service.createMaterial(title, goalId);
          await refresh(created.id);
          setMessage("教材を作成しました。");
        }} />
      </div>

      {loading && <div className="panel">教材を読み込んでいます…</div>}
      {!loading && materials.length === 0 && <div className="panel empty-state"><h3>教材を作成してください</h3><p>教材を作成後、セクションと問題を追加できます。</p></div>}

      {materials.length > 0 && (
        <div className="panel material-selector-card">
          <label>編集する教材
            <select value={selectedId} onChange={(event) => {
              const nextId = event.target.value;
              if (
                customMetricEditorDirty
                && !window.confirm("カスタムメトリクスに未保存の変更があります。破棄して教材を切り替えますか？")
              ) {
                return;
              }
              setCustomMetricEditorDirty(false);
              setSelectedId(nextId);
            }}>
              {materials.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}
            </select>
          </label>
        </div>
      )}

      {material && (
        <>
          <div className="panel material-master-heading">
            <div><span className="eyebrow">教材</span><h2>{material.title}</h2><p>{material.sections.length}セクション・{problemCount}問</p></div>
            <div className="master-actions">
              <button onClick={() => void exportLearningHistory(material)}>学習履歴をエクスポート</button>
              <button onClick={() => setRenaming(true)}>教材名を編集</button>
              <button className="danger-button" onClick={() => setDeletingMaterial(true)}>教材を削除</button>
            </div>
          </div>
          <CustomMetricSettingsPanel
            questionBankId={material.id}
            onNotify={onNotify}
            onEditorDirtyChange={setCustomMetricEditorDirty}
          />
          <SectionCreateForm onCreate={(input) => run(() => service.addSection(material, input), "セクションを追加しました。", material.id)} />
          {material.sections.length === 0 && <div className="panel empty-state"><p>セクションを追加すると問題を登録できます。</p></div>}
          {material.sections.map((section) => (
            <section className="panel master-section" key={section.id}>
              <div className="panel-heading">
                <div>
                  <span className="eyebrow">{evaluationLabels[section.evaluationType]}{section.isMockExamSection ? "・模試対象" : ""}</span>
                  <h3>{section.title}</h3>
                </div>
                <div className="master-actions">
                  <button onClick={() => setEditingSection(section)}>編集</button>
                  <button className="danger-button" onClick={() => setDeletingSection(section)}>削除</button>
                </div>
              </div>
              <ProblemCreateForm sectionId={section.id} onAdd={(sectionId, count, maxScore) =>
                run(() => service.addProblems(material, sectionId, { count, defaultMaxScore: maxScore }), `${count}問追加しました。`, material.id)
              } />
              <div className="problem-table-wrap">
                <table className="problem-table master-problem-table">
                  <thead><tr><th>問題番号</th><th>問題名</th><th>問題形式</th><th>配点</th><th>補足情報</th><th>操作</th></tr></thead>
                  <tbody>
                    {section.problems.length === 0 && <tr><td colSpan={6}>問題はまだありません。</td></tr>}
                    {section.problems.map((problem) => (
                      <tr key={problem.id}>
                        <td>No.{problem.number}</td>
                        <td>{problem.title || "—"}</td>
                        <td>{evaluationLabels[problem.evaluationTypeOverride || section.evaluationType]}</td>
                        <td>{problem.defaultMaxScore}点</td>
                        <td>{problem.supplementalInfo || "—"}</td>
                        <td><button onClick={() => setEditingProblem(problem)}>編集</button><button className="danger-button" onClick={() => setDeletingProblem(problem)}>削除</button></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          ))}
        </>
      )}

      {material && renaming && <ModalBackdrop onClose={() => setRenaming(false)}><RenameMaterialPanel material={material} onCancel={() => setRenaming(false)} onSave={async (title) => {
        await run(() => service.renameMaterial(material, title), "教材名を更新しました。", material.id);
        setRenaming(false);
      }} /></ModalBackdrop>}
      {material && deletingMaterial && <ModalBackdrop onClose={() => setDeletingMaterial(false)}><DeleteMasterPanel title={`${material.title}を削除しますか？`} warning={`セクション・問題・解答履歴・周回も削除されます。現在 ${problemCount}問です。`} onCancel={() => setDeletingMaterial(false)} onDelete={async () => {
        await run(() => service.deleteMaterial(material.id), "教材を削除しました。");
        setDeletingMaterial(false);
      }} /></ModalBackdrop>}
      {material && editingSection && <ModalBackdrop onClose={() => setEditingSection(null)}><SectionEditPanel section={editingSection} onCancel={() => setEditingSection(null)} onSave={async (input) => {
        await run(() => service.updateSection(material, editingSection.id, input), "セクションを更新しました。", material.id);
        setEditingSection(null);
      }} /></ModalBackdrop>}
      {material && deletingSection && <ModalBackdrop onClose={() => setDeletingSection(null)}><DeleteMasterPanel title={`${deletingSection.title}を削除しますか？`} warning={`所属する問題 ${deletingSection.problems.length}問と、その解答履歴も削除されます。`} onCancel={() => setDeletingSection(null)} onDelete={async () => {
        await run(() => service.deleteSection(deletingSection.id), "セクションを削除しました。", material.id);
        setDeletingSection(null);
      }} /></ModalBackdrop>}
      {material && editingProblem && <ModalBackdrop onClose={() => setEditingProblem(null)}><ProblemEditPanel bank={material} problem={editingProblem} onCancel={() => setEditingProblem(null)} onSave={async (input) => {
        await run(() => service.updateProblem(material, editingProblem.id, input), "問題を更新しました。", material.id);
        setEditingProblem(null);
      }} /></ModalBackdrop>}
      {deletingProblem && <ModalBackdrop onClose={() => setDeletingProblem(null)}><DeleteProblemPanel problem={deletingProblem} onCancel={() => setDeletingProblem(null)} onDelete={async () => {
        await run(() => service.deleteProblem(deletingProblem.id), "問題を削除しました。", material?.id);
        setDeletingProblem(null);
      }} /></ModalBackdrop>}
    </section>
  );
}

function MaterialCreateForm({ onCreate }: { onCreate: (title: string) => Promise<void> }) {
  const [title, setTitle] = useState("");
  const [saving, setSaving] = useState(false);
  return <form className="inline-create-form" onSubmit={async (event) => {
    event.preventDefault();
    if (saving) return;
    setSaving(true);
    try { await onCreate(title); setTitle(""); } finally { setSaving(false); }
  }}><input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="教材名" aria-label="教材名" required /><button className="primary-button" disabled={saving}>{saving ? "作成中…" : "教材を作成"}</button></form>;
}

function SectionCreateForm({ onCreate }: { onCreate: (input: { title: string; evaluationType: EvaluationType; isMockExamSection: boolean }) => Promise<void> }) {
  const [title, setTitle] = useState("");
  const [evaluationType, setEvaluationType] = useState<EvaluationType>("binary");
  const [mock, setMock] = useState(false);
  return <form className="panel section-create" onSubmit={async (event) => { event.preventDefault(); await onCreate({ title, evaluationType, isMockExamSection: mock }); setTitle(""); }}>
    <h3>セクションを追加</h3>
    <input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="例: 第1章 基礎" required />
    <select value={evaluationType} onChange={(event) => setEvaluationType(event.target.value as EvaluationType)}><option value="binary">正誤</option><option value="partial_score">部分点</option><option value="mixed">混在</option></select>
    <label className="check-label"><input type="checkbox" checked={mock} onChange={(event) => setMock(event.target.checked)} />模試形式の対象</label>
    <button>追加</button>
  </form>;
}

function ProblemCreateForm({ sectionId, onAdd }: { sectionId: string; onAdd: (sectionId: string, count: number, maxScore: number) => Promise<void> }) {
  const [count, setCount] = useState(1);
  const [maxScore, setMaxScore] = useState(1);
  return <form className="add-problems-form" onSubmit={(event) => { event.preventDefault(); void onAdd(sectionId, count, maxScore); }}>
    <label>追加数<input type="number" min="1" max="500" value={count} onChange={(event) => setCount(event.target.valueAsNumber)} /></label>
    <label>初期配点<input type="number" min="1" step="0.001" value={maxScore} onChange={(event) => setMaxScore(event.target.valueAsNumber)} /></label>
    <button>問題を追加</button>
  </form>;
}

function RenameMaterialPanel({ material, onCancel, onSave }: { material: QuestionBank; onCancel: () => void; onSave: (title: string) => Promise<void> }) {
  const [title, setTitle] = useState(material.title);
  return <form className="modal-panel" onSubmit={(event) => { event.preventDefault(); void onSave(title); }}><h2>教材名を編集</h2><label>教材名<input autoFocus value={title} onChange={(event) => setTitle(event.target.value)} required /></label><div className="modal-actions"><button type="button" onClick={onCancel}>キャンセル</button><button className="primary-button">保存</button></div></form>;
}

function SectionEditPanel({ section, onCancel, onSave }: { section: QuestionSection; onCancel: () => void; onSave: (input: { title: string; evaluationType: EvaluationType }) => Promise<void> }) {
  const [title, setTitle] = useState(section.title);
  const [evaluationType, setEvaluationType] = useState(section.evaluationType);
  return <form className="modal-panel" onSubmit={(event) => { event.preventDefault(); void onSave({ title, evaluationType }); }}><h2>セクションを編集</h2><label>セクション名<input autoFocus value={title} onChange={(event) => setTitle(event.target.value)} required /></label><label>問題形式<select value={evaluationType} onChange={(event) => setEvaluationType(event.target.value as EvaluationType)}><option value="binary">正誤</option><option value="partial_score">部分点</option><option value="mixed">混在</option></select></label><div className="modal-actions"><button type="button" onClick={onCancel}>キャンセル</button><button className="primary-button">保存</button></div></form>;
}

function DeleteMasterPanel({ title, warning, onCancel, onDelete }: { title: string; warning: string; onCancel: () => void; onDelete: () => Promise<void> }) {
  const [deleting, setDeleting] = useState(false);
  return <section className="modal-panel" role="alertdialog" aria-modal="true"><h2>{title}</h2><p>この操作は取り消せません。</p><p className="delete-warning">{warning}</p><div className="modal-actions"><button onClick={onCancel}>キャンセル</button><button className="danger-button" disabled={deleting} onClick={async () => { if (deleting) return; setDeleting(true); try { await onDelete(); } finally { setDeleting(false); } }}>{deleting ? "削除中…" : "削除する"}</button></div></section>;
}
