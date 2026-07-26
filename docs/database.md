# データベース

## 概要

GoalForgeデスクトップ版はSQLiteを使用します。DBファイル`goalforge.sqlite`は、Tauriが決定するmacOSのApplication Supportディレクトリに保存し、Gitでは管理しません。

- 外部キー: 有効
- Journal mode: WAL
- 得点: 1000分の1点単位の整数
- スキーマ履歴: `schema_migrations`
- 旧データ移行履歴: `data_migrations`

## ER図

```mermaid
erDiagram
    materials ||--|| question_banks : "1対1"
    question_banks ||--o{ question_sections : contains
    question_sections ||--o{ problems : contains
    question_banks ||--o{ practice_rounds : has
    practice_rounds ||--o{ round_target_problems : snapshots
    problems ||--o{ round_target_problems : targeted
    practice_rounds ||--o{ problem_attempts : records
    problems ||--o{ problem_attempts : answered
```

`question_banks`は既存UI/APIとの互換レイヤーとして残し、ユニークインデックスにより`materials`と1対1に制約しています。

## テーブル一覧

| テーブル | 役割 | 主な関連 |
|---|---|---|
| `schema_migrations` | 適用済みスキーマMigration | バージョンを一意に管理 |
| `app_state` | アプリ状態のJSON保存 | キー単位 |
| `data_migrations` | LocalStorageなどのデータ移行履歴 | 移行キー単位 |
| `materials` | 教材マスター | 目標ID、教材名 |
| `question_banks` | 教材に対応する演習構造の互換レイヤー | `materials`と1対1 |
| `question_sections` | 教材内のセクション | 評価形式、模試区分、並び順 |
| `problems` | 問題マスター | 配点、評価形式、復習状態、補足情報 |
| `practice_rounds` | 教材ごとの演習周回 | 周回番号、開始・完了日時 |
| `round_target_problems` | 周回開始時の対象問題スナップショット | 周回と問題の中間テーブル |
| `problem_attempts` | 問題単位の解答履歴 | 得点、満点、確信度、メモ、解答日時 |

## データ設計上の原則

- 教材・セクション・問題はマスターとして一意に管理します。
- 周回と履歴はマスターIDを参照し、教材を複製しません。
- 過去の採点結果を保つため、解答時点の満点を`problem_attempts.max_score_milli`へ保存します。
- 周回対象は`round_target_problems`へ保存し、後の復習状態変更から独立させます。
- 削除時の関連データは外部キーと`ON DELETE CASCADE`で一貫させます。

## Migration管理

Migration SQLは`src-tauri/migrations/`へ`NNN_description.sql`形式で追加します。現在は次のMigrationがあります。

1. `001_initial.sql`: 初期テーブル、外部キー、制約、インデックス
2. `002_problem_details_and_confidence.sql`: 問題補足情報と3段階の確信度
3. `003_material_master.sql`: 教材と演習構造の1対1制約

新しいMigrationを追加するときは、Tauri起動時の適用処理にも同じバージョンを登録します。

### 方針

- 適用済みSQLは変更しません。
- 既存データを保持する前進Migrationを追加します。
- SQLiteで制約変更のためにテーブル再作成が必要な場合は、トランザクション内で新テーブル作成、データ変換、旧テーブル削除、リネーム、インデックス再作成を行います。
- Migration失敗時は途中状態を残さないようにします。
- 外部キー、ユニーク制約、チェック制約、インデックスの再現を確認します。
- 変更後は既存DBからのMigrationと新規DB作成の両方を確認します。

## TODO

- スキーマMigration適用処理を連番リスト化し、追加漏れを検知する
- バックアップJSONのスキーマバージョンと復元互換性を文書化する
- クラウド同期を導入する場合の同期メタデータと競合解決方式を設計する
