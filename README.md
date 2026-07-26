# GoalForge

中国語検定などの学習目標、教材、問題単位の解答履歴を管理するmacOSデスクトップアプリです。Tauri 2、React、TypeScript、Vite、SQLiteで構成しています。

GoalForgeでは、教材管理をマスター、演習を学習履歴、ダッシュボードを統計・分析として分離します。履歴を持つために教材を複製せず、一つの教材マスターを継続して利用します。

## 主な機能

- SQLiteによる教材・セクション・問題のマスター管理
- 正誤・部分点・確信度・復習状態を含むAttempt履歴
- 問題一覧の絞り込みから直接登録できる通常演習と、独立した模試集計
- Attemptを基にしたAnalytics
- SQLiteバックアップ／リストア
- 中国語検定教材専用インポートCLI
- 目標、教材進捗、学習計画、ペースの管理
- AnkiConnect同期とオフライン時の最終同期データ表示
- SQLite Migration、旧LocalStorage移行

## スクリーンショット

TODO: ダッシュボード、教材管理、演習、解答履歴のスクリーンショットを追加します。

## 技術スタック

- Tauri 2 / Rust
- React 19 / TypeScript
- Vite 7
- SQLite / rusqlite
- Node.js標準テストランナー

## ディレクトリ構成

```text
.
├── docs/                 設計、DB、ロードマップ、UI
├── scripts/              ドメインロジックと入力検証のテスト
├── src/                  Reactフロントエンド
│   └── questionBank/     教材管理・演習のドメインとUI
├── src-tauri/
│   ├── migrations/       SQLite Migration
│   └── src/              TauriコマンドとSQLiteアクセス
├── CONTRIBUTING.md       開発フローと品質基準
└── package.json
```

## データ保存

学習データの正本はSQLiteです。Tauriが決定するmacOSのApplication Supportディレクトリ配下に `goalforge.sqlite` を保存し、リポジトリやアプリバンドルには保存しません。実際の保存場所とDBスキーマバージョンは「データ管理」画面で確認できます。

- 外部キー制約を有効化
- WALモードと終了時チェックポイント
- SQLマイグレーションを起動時に順次適用
- 教材・大問・問題の一括保存、模試作成、解答登録と状態更新をトランザクション化
- 得点は1000分の1点単位の整数で保存
- LocalStorageは旧Web版からの初回移行元と、消失しても復元可能なUI設定だけに限定

旧Web版の `goalforge.appState.v2` が存在し、SQLite側にデータがない場合は、初回起動時に1トランザクションで移行します。成功後も旧LocalStorageデータは削除しません。移行済みバージョンをSQLiteに記録するため、重複移行せず、失敗時は再実行できます。

## セットアップ

Node.jsに加えて、Tauri 2が対応するRustツールチェーンとApple Command Line Toolsが必要です。

```bash
npm install
```

通常のnpmキャッシュに権限問題がある場合:

```bash
npm_config_cache=/private/tmp/goalforge-npm-cache npm install
```

## 開発方法

macOSデスクトップ版:

```bash
npm run tauri:dev
```

フロントエンドだけの表示確認:

```bash
npm run dev
```

ブラウザ単体ではSQLiteへ接続できないため、問題集の編集と学習データの永続化は行いません。

開発フロー、ブランチ、コミット、Pull Request、Migrationのルールは[CONTRIBUTING.md](CONTRIBUTING.md)を参照してください。設計資料は[`docs/`](docs/)にあります。

## build方法

フロントエンド:

```bash
npm run build
```

macOSアプリ:

```bash
npm run tauri:build
```

生成された `.app` / `.dmg` はTauriの `target/release/bundle` 配下に出力されます。

## テスト

```bash
npm test
npm run test:validation
```

問題集テストでは得点結果、自信、未解答の扱い、除外状態、履歴の満点スナップショット、模擬試験集計を確認します。

## 問題集の使い方

1. 「問題集」で問題集を作成する
2. 大問の評価形式（正誤・部分点・混在）と模擬試験設定を選ぶ
3. 大問ごとに問題数と既定配点を入力して追加する
4. 「演習」の問題一覧を、状態・最新の解答・確信度・最新日の条件で絞り込む（各カテゴリは複数選択可能）
5. 各問題の「解答」から、○・×または得点、自信を入力して保存する
6. 問題一覧で一括状態変更、履歴の編集・削除を行う
7. 模試対象の大問をまとめて採点する場合だけ「新しい模試を開始」を使う

集計値は保存せず、問題ごとの解答履歴から算出します。

## AnkiConnect

Mac版Ankiを起動し、AnkiConnectが `http://127.0.0.1:8765` で利用できる状態にしてから、アプリ内の「Ankiと同期」を押します。Ankiが起動していない場合も、画面は壊れずSQLiteに保存した前回同期データを表示します。

## 配布

本アプリはSQLiteを利用するmacOSデスクトップアプリのため、通常利用版は静的Web公開ではなくTauriの `.app` / `.dmg` として配布します。コード署名・公証は配布先を広げる段階で設定してください。

## ライセンス

ライセンスは未定です。公開・配布範囲を決定したうえで、`LICENSE`ファイルを追加します。
