# Changelog

GoalForgeの主な変更をバージョンごとに記録します。

## v0.8.0 (2026-07-26)

### Added

- 中国語検定3級教材（筆記・リスニング）の専用移行CLI
- Attemptに`attempt_number`
- SQLite Online Backupを利用した安全な移行
- Migration IDによる再実行防止

### Changed

- `answered_at`をnullableに変更
- Attempt履歴を`attempt_number`基準へ変更
- NULL日時を「学習日不明」と表示
- Analyticsを`attempt_number`基準へ変更

### Fixed

- NULL日時Attempt読込不具合
- release版でのNULL読込エラー

### Migration

中国語検定3級教材：

- Materials: 2
- Sections: 41
- Problems: 661
- Attempts: 1,446
- Rounds: 9
- Migration ID: `import-chuken3-trainingbook-v1`
