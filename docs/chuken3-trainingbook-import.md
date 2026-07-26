# 中国語検定3級トレーニングブック移行

`scripts/import-chuken3-trainingbook.ts`は、`中国語検定2級.numbers`内の
`筆記（3級）`と`リスニング（3級）`だけをGoalForgeへ一度だけ移行する専用CLIです。
汎用Import形式、Import UI、外部公開データ形式として使用しません。

## 解答順とRound

- 各Problemの空でない回答を、回答列の左から順に`attempt_number=1,2,3,...`と採番します。
- `attempt_number`に欠番や重複を作りません。
- 元の回答列が空の場合、元回答列番号と`attempt_number`は一致しないことがあります。
- Round番号は元回答列番号を保持します。回答2由来のAttemptは、`attempt_number=1`でもRound 2に所属します。
- 元日時が空のAttemptは`answered_at=NULL`とし、仮日時や補完noteを作りません。

## 固定検証値

| 項目 | 件数 |
|---|---:|
| 教材 | 2 |
| Section | 41 |
| Problem | 661 |
| Attempt | 1,446 |
| Round | 9 |
| 日時NULL | 300 |
| 回答0 | 501 |
| 回答1 | 343 |
| 回答2 | 602 |

Migration IDは`import-chuken3-trainingbook-v1`です。同じMigration IDまたは同名教材が
存在する場合は停止します。

## 実行順

CLIは次の順で処理します。

1. Numbersを一時Excelへ書き出し、対象2シートと固定件数を検証
2. 実DBの`integrity_check`、`foreign_key_check`、Migration ID、同名教材を読み取り確認
3. SQLiteのオンラインバックアップを作成
4. バックアップの`integrity_check`を確認
5. 既存の教材保存処理を利用して、移行全体を1トランザクションで保存
6. 固定件数、解答順、日時NULL、得点・確信度、DB整合性を照合してからコミット

途中で検証または保存に失敗した場合、データ移行トランザクションはロールバックされます。
