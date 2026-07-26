use chrono::{Local, Utc};
use rusqlite::{backup::Backup, params, Connection, OpenFlags, OptionalExtension, Transaction};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::HashSet,
    fs,
    io::{Read, Write},
    net::{TcpStream, ToSocketAddrs},
    path::{Path, PathBuf},
    sync::Mutex,
    time::Duration,
};
use tauri::{Manager, State};
use uuid::Uuid;

pub mod chuken3_import;
pub mod custom_metric_api;
pub mod custom_metric_evaluator;
pub mod custom_metric_management_service;
pub mod custom_metric_repository;
pub mod custom_metric_service;
pub mod custom_metrics;
use custom_metric_api::{
    create_custom_metric_with_connection, delete_custom_metric_with_connection,
    get_custom_metric_summaries_from_connection, list_custom_metrics_from_connection,
    move_custom_metric_with_connection, reset_custom_metrics_with_connection,
    restore_default_custom_metric_with_connection, set_custom_metric_visibility_with_connection,
    update_custom_metric_with_connection, CustomMetricDefinitionDto,
    CustomMetricManagementErrorDto, CustomMetricSummaryDto, CustomMetricWriteDto,
};
use custom_metrics::{seed_default_metrics, RestoreDefaultMetricOutcome};

const CURRENT_SCHEMA_VERSION: i64 = 6;
const REQUIRED_TABLES: [&str; 10] = [
    "app_state",
    "data_migrations",
    "materials",
    "practice_rounds",
    "problem_attempts",
    "problems",
    "question_banks",
    "question_sections",
    "round_target_problems",
    "schema_migrations",
];

struct Database {
    connection: Mutex<Connection>,
    path: PathBuf,
}

const LEGACY_BUNDLE_IDENTIFIER: &str = "jp.kenta.goalforge";
const DATABASE_FILENAME: &str = "goalforge.sqlite";

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DatabaseSummary {
    materials: i64,
    sections: i64,
    problems: i64,
    attempts: i64,
    rounds: i64,
    round_targets: i64,
    custom_metrics: i64,
    goals: i64,
    study_plans: i64,
    schema_version: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RestoreResult {
    summary: DatabaseSummary,
    automatic_backup_path: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct QuestionBank {
    id: String,
    material_id: String,
    title: String,
    sections: Vec<QuestionSection>,
    rounds: Vec<PracticeRound>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct QuestionSection {
    id: String,
    question_bank_id: String,
    title: String,
    order: i64,
    evaluation_type: String,
    is_mock_exam_section: bool,
    problems: Vec<Problem>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Problem {
    id: String,
    section_id: String,
    number: String,
    title: Option<String>,
    order: i64,
    default_max_score: f64,
    evaluation_type_override: Option<String>,
    supplemental_info: Option<String>,
    correct_answer: Option<String>,
    review_status: String,
    attempts: Vec<ProblemAttempt>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ProblemAttempt {
    id: String,
    problem_id: String,
    round_id: String,
    answered_at: Option<String>,
    attempt_number: i64,
    earned_score: f64,
    max_score: f64,
    confidence: Option<String>,
    note: Option<String>,
    user_answer: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct PracticeRound {
    id: String,
    question_bank_id: String,
    round_number: i64,
    title: Option<String>,
    started_at: String,
    completed_at: Option<String>,
    target_problem_ids: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AttemptInput {
    id: Option<String>,
    problem_id: String,
    round_id: String,
    answered_at: Option<String>,
    earned_score: f64,
    max_score: f64,
    confidence: Option<String>,
    note: Option<String>,
    user_answer: Option<String>,
    correct_answer: Option<String>,
    next_review_status: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LegacyMigrationResult {
    migrated: bool,
    already_migrated: bool,
    message: String,
}

fn now() -> String {
    Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

fn milli(value: f64) -> Result<i64, String> {
    if !value.is_finite() {
        return Err("点数が不正です。".into());
    }
    Ok((value * 1000.0).round() as i64)
}

fn score(value: i64) -> f64 {
    value as f64 / 1000.0
}

fn apply_migrations(connection: &mut Connection) -> Result<(), String> {
    let applied = connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='schema_migrations')",
            [],
            |row| row.get::<_, bool>(0),
        )
        .unwrap_or(false);
    let has_v1 = applied
        && connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM schema_migrations WHERE version = 1)",
                [],
                |row| row.get::<_, bool>(0),
            )
            .unwrap_or(false);
    if !has_v1 {
        let transaction = connection
            .transaction()
            .map_err(|error| error.to_string())?;
        transaction
            .execute_batch(include_str!("../migrations/001_initial.sql"))
            .map_err(|error| error.to_string())?;
        transaction
            .execute(
                "INSERT INTO schema_migrations(version, applied_at) VALUES (1, ?1)",
                [now()],
            )
            .map_err(|error| error.to_string())?;
        transaction.commit().map_err(|error| error.to_string())?;
    }
    let has_v2 = connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM schema_migrations WHERE version = 2)",
            [],
            |row| row.get::<_, bool>(0),
        )
        .unwrap_or(false);
    if !has_v2 {
        let transaction = connection
            .transaction()
            .map_err(|error| error.to_string())?;
        transaction
            .execute_batch(include_str!(
                "../migrations/002_problem_details_and_confidence.sql"
            ))
            .map_err(|error| error.to_string())?;
        transaction
            .execute(
                "INSERT INTO schema_migrations(version, applied_at) VALUES (2, ?1)",
                [now()],
            )
            .map_err(|error| error.to_string())?;
        transaction.commit().map_err(|error| error.to_string())?;
    }
    let has_v3 = connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM schema_migrations WHERE version = 3)",
            [],
            |row| row.get::<_, bool>(0),
        )
        .unwrap_or(false);
    if !has_v3 {
        let transaction = connection
            .transaction()
            .map_err(|error| error.to_string())?;
        transaction
            .execute_batch(include_str!("../migrations/003_material_master.sql"))
            .map_err(|error| error.to_string())?;
        transaction
            .execute(
                "INSERT INTO schema_migrations(version, applied_at) VALUES (3, ?1)",
                [now()],
            )
            .map_err(|error| error.to_string())?;
        transaction.commit().map_err(|error| error.to_string())?;
    }
    let has_v4 = connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM schema_migrations WHERE version = 4)",
            [],
            |row| row.get::<_, bool>(0),
        )
        .unwrap_or(false);
    if !has_v4 {
        let transaction = connection
            .transaction()
            .map_err(|error| error.to_string())?;
        transaction
            .execute_batch(include_str!("../migrations/004_attempt_number.sql"))
            .map_err(|error| error.to_string())?;
        transaction
            .execute(
                "INSERT INTO schema_migrations(version, applied_at) VALUES (4, ?1)",
                [now()],
            )
            .map_err(|error| error.to_string())?;
        transaction.commit().map_err(|error| error.to_string())?;
    }
    let has_v5 = connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM schema_migrations WHERE version = 5)",
            [],
            |row| row.get::<_, bool>(0),
        )
        .unwrap_or(false);
    if !has_v5 {
        let transaction = connection
            .transaction()
            .map_err(|error| error.to_string())?;
        transaction
            .execute_batch(include_str!("../migrations/005_custom_metrics.sql"))
            .map_err(|error| error.to_string())?;
        let bank_ids = {
            let mut statement = transaction
                .prepare("SELECT id FROM question_banks ORDER BY id")
                .map_err(|error| error.to_string())?;
            let ids = statement
                .query_map([], |row| row.get::<_, String>(0))
                .map_err(|error| error.to_string())?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|error| error.to_string())?;
            ids
        };
        for bank_id in bank_ids {
            seed_default_metrics(&transaction, &bank_id)?;
        }
        transaction
            .execute(
                "INSERT INTO schema_migrations(version, applied_at) VALUES (5, ?1)",
                [now()],
            )
            .map_err(|error| error.to_string())?;
        transaction.commit().map_err(|error| error.to_string())?;
    }
    let has_v6 = connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM schema_migrations WHERE version = 6)",
            [],
            |row| row.get::<_, bool>(0),
        )
        .unwrap_or(false);
    if !has_v6 {
        let transaction = connection
            .transaction()
            .map_err(|error| error.to_string())?;
        transaction
            .execute_batch(include_str!("../migrations/006_answer_text.sql"))
            .map_err(|error| error.to_string())?;
        transaction
            .execute(
                "INSERT INTO schema_migrations(version, applied_at) VALUES (6, ?1)",
                [now()],
            )
            .map_err(|error| error.to_string())?;
        transaction.commit().map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn migrate_legacy_bundle_database(data_dir: &Path) -> Result<(), String> {
    let target_database = data_dir.join(DATABASE_FILENAME);
    if target_database.exists() {
        return Ok(());
    }

    let Some(application_support_dir) = data_dir.parent() else {
        return Ok(());
    };
    let legacy_database = application_support_dir
        .join(LEGACY_BUNDLE_IDENTIFIER)
        .join(DATABASE_FILENAME);
    if !legacy_database.exists() {
        return Ok(());
    }

    fs::create_dir_all(data_dir).map_err(|error| error.to_string())?;
    for suffix in ["", "-wal", "-shm"] {
        let source = PathBuf::from(format!("{}{}", legacy_database.display(), suffix));
        if source.exists() {
            let destination = PathBuf::from(format!("{}{}", target_database.display(), suffix));
            fs::copy(&source, &destination).map_err(|error| {
                format!(
                    "旧GoalForgeデータを移行できませんでした（{} → {}）: {error}",
                    source.display(),
                    destination.display()
                )
            })?;
        }
    }

    Ok(())
}

fn configure_database(connection: &Connection) -> Result<(), String> {
    connection
        .execute_batch(
            "PRAGMA foreign_keys = ON;
             PRAGMA journal_mode = WAL;
             PRAGMA synchronous = NORMAL;
             PRAGMA busy_timeout = 5000;",
        )
        .map_err(|error| error.to_string())
}

fn initialize_database(path: &PathBuf) -> Result<Connection, String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let mut connection = Connection::open(path).map_err(|error| error.to_string())?;
    configure_database(&connection)?;
    apply_migrations(&mut connection)?;
    Ok(connection)
}

fn table_count(connection: &Connection, table: &str) -> Result<i64, String> {
    connection
        .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
            row.get(0)
        })
        .map_err(|error| error.to_string())
}

fn optional_table_count(connection: &Connection, table: &str) -> Result<i64, String> {
    let exists: bool = connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1)",
            [table],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;
    if exists {
        table_count(connection, table)
    } else {
        Ok(0)
    }
}

fn app_state_array_count(connection: &Connection, key: &str) -> Result<i64, String> {
    let json: Option<String> = connection
        .query_row(
            "SELECT value_json FROM app_state WHERE key = 'main'",
            [],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    let Some(json) = json else {
        return Ok(0);
    };
    let state: Value = serde_json::from_str(&json)
        .map_err(|_| "設定データのJSONが壊れているため、件数を取得できません。".to_string())?;
    Ok(state
        .get(key)
        .and_then(Value::as_array)
        .map(|items| items.len() as i64)
        .unwrap_or(0))
}

fn database_summary(connection: &Connection) -> Result<DatabaseSummary, String> {
    let schema_version = connection
        .query_row(
            "SELECT COALESCE(MAX(version), 0) FROM schema_migrations",
            [],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;
    Ok(DatabaseSummary {
        materials: table_count(connection, "materials")?,
        sections: table_count(connection, "question_sections")?,
        problems: table_count(connection, "problems")?,
        attempts: table_count(connection, "problem_attempts")?,
        rounds: table_count(connection, "practice_rounds")?,
        round_targets: table_count(connection, "round_target_problems")?,
        custom_metrics: optional_table_count(connection, "custom_metrics")?,
        goals: app_state_array_count(connection, "goals")?,
        study_plans: app_state_array_count(connection, "studyPlans")?,
        schema_version,
    })
}

fn check_sqlite_header(path: &Path) -> Result<(), String> {
    let mut file = fs::File::open(path)
        .map_err(|error| format!("バックアップファイルを読み込めません: {error}"))?;
    let mut header = [0_u8; 16];
    if file.read_exact(&mut header).is_err() || &header != b"SQLite format 3\0" {
        return Err("選択したファイルはSQLiteデータベースではありません。".into());
    }
    Ok(())
}

fn validate_goalforge_database(connection: &Connection) -> Result<i64, String> {
    let integrity: String = connection
        .query_row("PRAGMA integrity_check", [], |row| row.get(0))
        .map_err(|error| format!("SQLiteの整合性を確認できません: {error}"))?;
    if integrity != "ok" {
        return Err(format!("SQLiteの整合性チェックに失敗しました: {integrity}"));
    }

    let schema_version: i64 = connection
        .query_row(
            "SELECT COALESCE(MAX(version), 0) FROM schema_migrations",
            [],
            |row| row.get(0),
        )
        .map_err(|error| format!("スキーマバージョンを確認できません: {error}"))?;

    let mut missing = Vec::new();
    for table in REQUIRED_TABLES {
        let exists: bool = connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1)",
                [table],
                |row| row.get(0),
            )
            .map_err(|error| error.to_string())?;
        if !exists {
            missing.push(table);
        }
    }
    if schema_version >= 5 {
        let custom_metrics_exists: bool = connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'custom_metrics')",
                [],
                |row| row.get(0),
            )
            .map_err(|error| error.to_string())?;
        if !custom_metrics_exists {
            missing.push("custom_metrics");
        }
    }
    if !missing.is_empty() {
        return Err(format!(
            "GoalForgeデータベースに必要なテーブルがありません: {}",
            missing.join(", ")
        ));
    }

    if schema_version > CURRENT_SCHEMA_VERSION {
        return Err(format!(
            "このバックアップのスキーマバージョンは{schema_version}です。現在のGoalForgeが対応するバージョン{CURRENT_SCHEMA_VERSION}より新しいため復元できません。"
        ));
    }
    Ok(schema_version)
}

fn check_foreign_keys(connection: &Connection) -> Result<(), String> {
    let mut statement = connection
        .prepare("PRAGMA foreign_key_check")
        .map_err(|error| error.to_string())?;
    let mut rows = statement.query([]).map_err(|error| error.to_string())?;
    if rows.next().map_err(|error| error.to_string())?.is_some() {
        return Err("外部キー整合性チェックに失敗しました。".into());
    }
    Ok(())
}

fn online_backup(source: &Connection, destination: &mut Connection) -> Result<(), String> {
    let backup = Backup::new(source, destination).map_err(|error| error.to_string())?;
    backup
        .run_to_completion(64, Duration::from_millis(20), None)
        .map_err(|error| error.to_string())
}

fn finalize_backup_file(connection: &Connection) -> Result<(), String> {
    connection
        .execute_batch("PRAGMA journal_mode = DELETE;")
        .map_err(|error| format!("バックアップファイルを確定できません: {error}"))?;
    validate_goalforge_database(connection)?;
    check_foreign_keys(connection)
}

fn remove_sqlite_sidecars(path: &Path) {
    let path = path.to_string_lossy();
    let _ = fs::remove_file(format!("{path}-wal"));
    let _ = fs::remove_file(format!("{path}-shm"));
}

fn open_read_only(path: &Path) -> Result<Connection, String> {
    Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|error| format!("SQLiteデータベースを開けません: {error}"))
}

#[tauri::command]
fn get_database_summary(database: State<Database>) -> Result<DatabaseSummary, String> {
    let connection = database
        .connection
        .lock()
        .map_err(|error| error.to_string())?;
    database_summary(&connection)
}

#[tauri::command]
fn create_database_backup(
    database: State<Database>,
    destination: String,
) -> Result<DatabaseSummary, String> {
    let destination = PathBuf::from(destination);
    let parent = destination
        .parent()
        .ok_or("バックアップの保存先が正しくありません。")?;
    fs::create_dir_all(parent).map_err(|error| format!("保存先を作成できません: {error}"))?;
    let temporary = parent.join(format!(".goalforge-backup-{}.tmp", Uuid::new_v4()));
    let result = (|| {
        let source = database
            .connection
            .lock()
            .map_err(|error| error.to_string())?;
        let mut target = Connection::open(&temporary)
            .map_err(|error| format!("バックアップファイルを作成できません: {error}"))?;
        online_backup(&source, &mut target)
            .map_err(|error| format!("完全バックアップに失敗しました: {error}"))?;
        finalize_backup_file(&target)?;
        let summary = database_summary(&target)?;
        drop(target);
        remove_sqlite_sidecars(&destination);
        fs::rename(&temporary, &destination)
            .map_err(|error| format!("バックアップファイルを保存できません: {error}"))?;
        Ok(summary)
    })();
    if temporary.exists() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

#[tauri::command]
fn inspect_database_backup(path: String) -> Result<DatabaseSummary, String> {
    let path = PathBuf::from(path);
    check_sqlite_header(&path)?;
    let connection = open_read_only(&path)?;
    validate_goalforge_database(&connection)?;
    check_foreign_keys(&connection)?;
    database_summary(&connection)
}

#[tauri::command]
fn restore_database_backup(
    database: State<Database>,
    path: String,
) -> Result<RestoreResult, String> {
    let source_path = PathBuf::from(path);
    check_sqlite_header(&source_path)?;
    let source = open_read_only(&source_path)?;
    let source_version = validate_goalforge_database(&source)?;
    check_foreign_keys(&source)?;

    let data_directory = database
        .path
        .parent()
        .ok_or("データベースの保存先を確認できません。")?;
    let restore_candidate =
        data_directory.join(format!(".goalforge-restore-{}.sqlite", Uuid::new_v4()));
    let backup_directory = data_directory.join("backups");
    fs::create_dir_all(&backup_directory)
        .map_err(|error| format!("自動バックアップの保存先を作成できません: {error}"))?;
    let automatic_backup = backup_directory.join(format!(
        "goalforge-before-restore-{}-{}.sqlite",
        Local::now().format("%Y%m%d-%H%M%S-%3f"),
        Uuid::new_v4()
    ));

    let result = (|| {
        let mut candidate = Connection::open(&restore_candidate)
            .map_err(|error| format!("復元用の一時DBを作成できません: {error}"))?;
        online_backup(&source, &mut candidate)
            .map_err(|error| format!("復元用DBの作成に失敗しました: {error}"))?;
        if source_version < CURRENT_SCHEMA_VERSION {
            apply_migrations(&mut candidate)
                .map_err(|error| format!("バックアップのMigrationに失敗しました: {error}"))?;
        }
        validate_goalforge_database(&candidate)?;
        check_foreign_keys(&candidate)?;

        let mut current = database
            .connection
            .lock()
            .map_err(|error| error.to_string())?;
        let mut safety_copy = Connection::open(&automatic_backup)
            .map_err(|error| format!("現在データの自動バックアップを作成できません: {error}"))?;
        online_backup(&current, &mut safety_copy)
            .map_err(|error| format!("現在データの自動バックアップに失敗しました: {error}"))?;
        finalize_backup_file(&safety_copy)?;
        drop(safety_copy);

        online_backup(&candidate, &mut current)
            .map_err(|error| format!("データベースの復元に失敗しました: {error}"))?;
        configure_database(&current)?;
        validate_goalforge_database(&current)?;
        check_foreign_keys(&current)?;
        let summary = database_summary(&current)?;
        Ok(RestoreResult {
            summary,
            automatic_backup_path: automatic_backup.to_string_lossy().into_owned(),
        })
    })();
    if result.is_err() && automatic_backup.exists() {
        if let Ok(safety_copy) = open_read_only(&automatic_backup) {
            if let Ok(mut current) = database.connection.lock() {
                let _ = online_backup(&safety_copy, &mut current);
                let _ = configure_database(&current);
            }
        }
    }
    drop(source);
    if restore_candidate.exists() {
        let _ = fs::remove_file(&restore_candidate);
    }
    result
}

#[tauri::command]
fn database_info(database: State<Database>) -> Result<Value, String> {
    let connection = database
        .connection
        .lock()
        .map_err(|error| error.to_string())?;
    let schema_version: i64 = connection
        .query_row(
            "SELECT COALESCE(MAX(version), 0) FROM schema_migrations",
            [],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;
    Ok(serde_json::json!({
        "path": database.path.to_string_lossy(),
        "schemaVersion": schema_version
    }))
}

#[tauri::command]
fn load_app_state(database: State<Database>) -> Result<Option<Value>, String> {
    let connection = database
        .connection
        .lock()
        .map_err(|error| error.to_string())?;
    let json: Option<String> = connection
        .query_row(
            "SELECT value_json FROM app_state WHERE key = 'main'",
            [],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    json.map(|value| serde_json::from_str(&value).map_err(|error| error.to_string()))
        .transpose()
}

#[tauri::command]
fn save_app_state(database: State<Database>, state: Value) -> Result<(), String> {
    let connection = database
        .connection
        .lock()
        .map_err(|error| error.to_string())?;
    connection
        .execute(
            "INSERT INTO app_state(key, value_json, updated_at) VALUES ('main', ?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at",
            params![state.to_string(), now()],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
fn migrate_legacy_state(
    database: State<Database>,
    state: Value,
) -> Result<LegacyMigrationResult, String> {
    let mut connection = database
        .connection
        .lock()
        .map_err(|error| error.to_string())?;
    let transaction = connection
        .transaction()
        .map_err(|error| error.to_string())?;
    let done: bool = transaction
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM data_migrations WHERE migration_key = 'localstorage.appState' AND version = 2)",
            [],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;
    if done {
        return Ok(LegacyMigrationResult {
            migrated: false,
            already_migrated: true,
            message: "既存データは移行済みです。".into(),
        });
    }
    validate_legacy_state(&state)?;
    transaction
        .execute(
            "INSERT INTO app_state(key, value_json, updated_at) VALUES ('main', ?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at",
            params![state.to_string(), now()],
        )
        .map_err(|error| error.to_string())?;
    transaction
        .execute(
            "INSERT INTO data_migrations(migration_key, version, completed_at, details_json)
             VALUES ('localstorage.appState', 2, ?1, ?2)",
            params![
                now(),
                serde_json::json!({"sourceKey": "goalforge.appState.v2"}).to_string()
            ],
        )
        .map_err(|error| error.to_string())?;
    transaction.commit().map_err(|error| error.to_string())?;
    Ok(LegacyMigrationResult {
        migrated: true,
        already_migrated: false,
        message: "既存の学習データをSQLiteへ移行しました。LocalStorageの原本は残しています。"
            .into(),
    })
}

fn validate_legacy_state(state: &Value) -> Result<(), String> {
    let object = state
        .as_object()
        .ok_or("既存データがJSONオブジェクトではありません。")?;
    for key in [
        "goals",
        "skills",
        "collections",
        "sources",
        "activities",
        "quests",
        "cityRewards",
        "studyPlans",
    ] {
        if let Some(value) = object.get(key) {
            if !value.is_array() {
                return Err(format!("既存データの{}が配列ではありません。", key));
            }
        }
    }
    Ok(())
}

#[tauri::command]
fn get_question_banks(database: State<Database>) -> Result<Vec<QuestionBank>, String> {
    let connection = database
        .connection
        .lock()
        .map_err(|error| error.to_string())?;
    load_banks(&connection)
}

fn load_banks(connection: &Connection) -> Result<Vec<QuestionBank>, String> {
    let mut statement = connection
        .prepare("SELECT id, material_id, title FROM question_banks ORDER BY created_at, title")
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })
        .map_err(|error| error.to_string())?;
    let mut banks = Vec::new();
    for row in rows {
        let (id, material_id, title) = row.map_err(|error| error.to_string())?;
        banks.push(QuestionBank {
            sections: load_sections(connection, &id)?,
            rounds: load_rounds(connection, &id)?,
            id,
            material_id,
            title,
        });
    }
    Ok(banks)
}

fn load_sections(connection: &Connection, bank_id: &str) -> Result<Vec<QuestionSection>, String> {
    let mut statement = connection
        .prepare(
            "SELECT id, title, sort_order, evaluation_type, is_mock_exam_section
             FROM question_sections WHERE question_bank_id = ?1 ORDER BY sort_order, id",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([bank_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, bool>(4)?,
            ))
        })
        .map_err(|error| error.to_string())?;
    let mut sections = Vec::new();
    for row in rows {
        let (id, title, order, evaluation_type, is_mock_exam_section) =
            row.map_err(|error| error.to_string())?;
        sections.push(QuestionSection {
            problems: load_problems(connection, &id)?,
            id,
            question_bank_id: bank_id.into(),
            title,
            order,
            evaluation_type,
            is_mock_exam_section,
        });
    }
    Ok(sections)
}

fn load_problems(connection: &Connection, section_id: &str) -> Result<Vec<Problem>, String> {
    let mut statement = connection
        .prepare(
            "SELECT id, number, title, sort_order, default_max_score_milli,
                    evaluation_type_override, review_status, supplemental_info, correct_answer
             FROM problems WHERE section_id = ?1 ORDER BY sort_order, id",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([section_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Option<String>>(2)?,
                row.get::<_, i64>(3)?,
                row.get::<_, i64>(4)?,
                row.get::<_, Option<String>>(5)?,
                row.get::<_, String>(6)?,
                row.get::<_, Option<String>>(7)?,
                row.get::<_, Option<String>>(8)?,
            ))
        })
        .map_err(|error| error.to_string())?;
    let mut problems = Vec::new();
    for row in rows {
        let (
            id,
            number,
            title,
            order,
            max_score,
            evaluation_type_override,
            review_status,
            supplemental_info,
            correct_answer,
        ) = row.map_err(|error| error.to_string())?;
        problems.push(Problem {
            attempts: load_attempts(connection, &id)?,
            id,
            section_id: section_id.into(),
            number,
            title,
            order,
            default_max_score: score(max_score),
            evaluation_type_override,
            supplemental_info,
            correct_answer,
            review_status,
        });
    }
    Ok(problems)
}

fn load_attempts(connection: &Connection, problem_id: &str) -> Result<Vec<ProblemAttempt>, String> {
    let mut statement = connection
        .prepare(
            "SELECT id, round_id, answered_at, attempt_number, earned_score_milli, max_score_milli, confidence, note, user_answer
             FROM problem_attempts WHERE problem_id = ?1 ORDER BY attempt_number DESC",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([problem_id], |row| {
            Ok(ProblemAttempt {
                id: row.get(0)?,
                problem_id: problem_id.into(),
                round_id: row.get(1)?,
                answered_at: row.get::<_, Option<String>>(2)?,
                attempt_number: row.get(3)?,
                earned_score: score(row.get(4)?),
                max_score: score(row.get(5)?),
                confidence: row.get(6)?,
                note: row.get(7)?,
                user_answer: row.get(8)?,
            })
        })
        .map_err(|error| error.to_string())?;
    rows.map(|row| row.map_err(|error| error.to_string()))
        .collect()
}

fn load_rounds(connection: &Connection, bank_id: &str) -> Result<Vec<PracticeRound>, String> {
    let mut statement = connection
        .prepare(
            "SELECT id, round_number, title, started_at, completed_at
             FROM practice_rounds WHERE question_bank_id = ?1 ORDER BY round_number",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([bank_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, Option<String>>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, Option<String>>(4)?,
            ))
        })
        .map_err(|error| error.to_string())?;
    let mut rounds = Vec::new();
    for row in rows {
        let (id, round_number, title, started_at, completed_at) =
            row.map_err(|error| error.to_string())?;
        let mut target_statement = connection
            .prepare("SELECT problem_id FROM round_target_problems WHERE round_id = ?1 ORDER BY sort_order")
            .map_err(|error| error.to_string())?;
        let target_problem_ids = target_statement
            .query_map([&id], |target| target.get(0))
            .map_err(|error| error.to_string())?
            .map(|target| target.map_err(|error| error.to_string()))
            .collect::<Result<Vec<String>, String>>()?;
        rounds.push(PracticeRound {
            id,
            question_bank_id: bank_id.into(),
            round_number,
            title,
            started_at,
            completed_at,
            target_problem_ids,
        });
    }
    Ok(rounds)
}

#[tauri::command]
fn save_question_bank(
    database: State<Database>,
    bank: QuestionBank,
) -> Result<QuestionBank, String> {
    let mut connection = database
        .connection
        .lock()
        .map_err(|error| error.to_string())?;
    let transaction = connection
        .transaction()
        .map_err(|error| error.to_string())?;
    save_bank_transaction(&transaction, &bank)?;
    transaction.commit().map_err(|error| error.to_string())?;
    let banks = load_banks(&connection)?;
    banks
        .into_iter()
        .find(|item| item.id == bank.id)
        .ok_or("保存した教材を取得できません。".into())
}

#[tauri::command]
fn get_custom_metric_summaries(
    database: State<Database>,
    question_bank_id: String,
) -> Result<Vec<CustomMetricSummaryDto>, String> {
    let connection = database
        .connection
        .lock()
        .map_err(|error| error.to_string())?;
    get_custom_metric_summaries_from_connection(&connection, &question_bank_id)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn list_custom_metrics(
    database: State<Database>,
    question_bank_id: String,
) -> Result<Vec<CustomMetricDefinitionDto>, CustomMetricManagementErrorDto> {
    let connection = database
        .connection
        .lock()
        .map_err(|error| CustomMetricManagementErrorDto::repository(error.to_string()))?;
    list_custom_metrics_from_connection(&connection, &question_bank_id)
}

#[tauri::command]
fn create_custom_metric(
    database: State<Database>,
    question_bank_id: String,
    input: CustomMetricWriteDto,
) -> Result<CustomMetricDefinitionDto, CustomMetricManagementErrorDto> {
    let mut connection = database
        .connection
        .lock()
        .map_err(|error| CustomMetricManagementErrorDto::repository(error.to_string()))?;
    create_custom_metric_with_connection(&mut connection, &question_bank_id, input)
}

#[tauri::command]
fn update_custom_metric(
    database: State<Database>,
    metric_id: String,
    input: CustomMetricWriteDto,
) -> Result<CustomMetricDefinitionDto, CustomMetricManagementErrorDto> {
    let mut connection = database
        .connection
        .lock()
        .map_err(|error| CustomMetricManagementErrorDto::repository(error.to_string()))?;
    update_custom_metric_with_connection(&mut connection, &metric_id, input)
}

#[tauri::command]
fn set_custom_metric_visibility(
    database: State<Database>,
    metric_id: String,
    is_visible: bool,
) -> Result<CustomMetricDefinitionDto, CustomMetricManagementErrorDto> {
    let mut connection = database
        .connection
        .lock()
        .map_err(|error| CustomMetricManagementErrorDto::repository(error.to_string()))?;
    set_custom_metric_visibility_with_connection(&mut connection, &metric_id, is_visible)
}

#[tauri::command]
fn move_custom_metric(
    database: State<Database>,
    metric_id: String,
    new_sort_order: i32,
) -> Result<Vec<CustomMetricDefinitionDto>, CustomMetricManagementErrorDto> {
    let mut connection = database
        .connection
        .lock()
        .map_err(|error| CustomMetricManagementErrorDto::repository(error.to_string()))?;
    move_custom_metric_with_connection(&mut connection, &metric_id, new_sort_order)
}

#[tauri::command]
fn delete_custom_metric(
    database: State<Database>,
    metric_id: String,
) -> Result<(), CustomMetricManagementErrorDto> {
    let mut connection = database
        .connection
        .lock()
        .map_err(|error| CustomMetricManagementErrorDto::repository(error.to_string()))?;
    delete_custom_metric_with_connection(&mut connection, &metric_id)
}

#[tauri::command]
fn restore_default_custom_metric(
    database: State<Database>,
    question_bank_id: String,
    system_key: String,
) -> Result<RestoreDefaultMetricOutcome, CustomMetricManagementErrorDto> {
    let mut connection = database
        .connection
        .lock()
        .map_err(|error| CustomMetricManagementErrorDto::repository(error.to_string()))?;
    restore_default_custom_metric_with_connection(&mut connection, &question_bank_id, &system_key)
}

#[tauri::command]
fn reset_custom_metrics(
    database: State<Database>,
    question_bank_id: String,
) -> Result<Vec<CustomMetricDefinitionDto>, CustomMetricManagementErrorDto> {
    let mut connection = database
        .connection
        .lock()
        .map_err(|error| CustomMetricManagementErrorDto::repository(error.to_string()))?;
    reset_custom_metrics_with_connection(&mut connection, &question_bank_id)
}

fn save_bank_transaction(transaction: &Transaction, bank: &QuestionBank) -> Result<(), String> {
    if bank.title.trim().is_empty() {
        return Err("教材名を入力してください。".into());
    }
    let timestamp = now();
    let bank_exists = transaction
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM question_banks WHERE id = ?1)",
            [&bank.id],
            |row| row.get::<_, bool>(0),
        )
        .map_err(|error| error.to_string())?;
    transaction
        .execute(
            "INSERT INTO materials(id, title, created_at, updated_at) VALUES (?1, ?2, ?3, ?3)
             ON CONFLICT(id) DO UPDATE SET title = excluded.title, updated_at = excluded.updated_at",
            params![bank.material_id, bank.title, timestamp],
        )
        .map_err(|error| error.to_string())?;
    transaction
        .execute(
            "INSERT INTO question_banks(id, material_id, title, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?4)
             ON CONFLICT(id) DO UPDATE SET material_id = excluded.material_id,
               title = excluded.title, updated_at = excluded.updated_at",
            params![bank.id, bank.material_id, bank.title, timestamp],
        )
        .map_err(|error| error.to_string())?;
    if !bank_exists {
        seed_default_metrics(transaction, &bank.id)?;
    }
    for section in &bank.sections {
        transaction
            .execute(
                "INSERT INTO question_sections(id, question_bank_id, title, sort_order, evaluation_type, is_mock_exam_section)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)
                 ON CONFLICT(id) DO UPDATE SET title=excluded.title, sort_order=excluded.sort_order,
                   evaluation_type=excluded.evaluation_type, is_mock_exam_section=excluded.is_mock_exam_section",
                params![section.id, bank.id, section.title, section.order, section.evaluation_type, section.is_mock_exam_section],
            )
            .map_err(|error| error.to_string())?;
        for problem in &section.problems {
            let max_score = milli(problem.default_max_score)?;
            if max_score < 1000 {
                return Err("問題の満点は1以上にしてください。".into());
            }
            transaction
                .execute(
                    "INSERT INTO problems(id, section_id, number, title, sort_order, default_max_score_milli,
                                          evaluation_type_override, review_status, supplemental_info, correct_answer)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
                     ON CONFLICT(id) DO UPDATE SET section_id=excluded.section_id, number=excluded.number,
                       title=excluded.title, sort_order=excluded.sort_order,
                       default_max_score_milli=excluded.default_max_score_milli,
                       evaluation_type_override=excluded.evaluation_type_override,
                       review_status=excluded.review_status, supplemental_info=excluded.supplemental_info,
                       correct_answer=excluded.correct_answer",
                    params![
                        problem.id, section.id, problem.number, problem.title, problem.order,
                        max_score, problem.evaluation_type_override, problem.review_status, problem.supplemental_info,
                        problem.correct_answer
                    ],
                )
                .map_err(|error| error.to_string())?;
        }
    }
    Ok(())
}

#[tauri::command]
fn delete_question_bank(database: State<Database>, id: String) -> Result<(), String> {
    let mut connection = database
        .connection
        .lock()
        .map_err(|error| error.to_string())?;
    let transaction = connection
        .transaction()
        .map_err(|error| error.to_string())?;
    let material_id: Option<String> = transaction
        .query_row(
            "SELECT material_id FROM question_banks WHERE id = ?1",
            [&id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    if let Some(material_id) = material_id {
        transaction
            .execute("DELETE FROM materials WHERE id = ?1", [material_id])
            .map_err(|error| error.to_string())?;
    }
    transaction.commit().map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
fn delete_question_section(database: State<Database>, id: String) -> Result<(), String> {
    let connection = database
        .connection
        .lock()
        .map_err(|error| error.to_string())?;
    connection
        .execute("DELETE FROM question_sections WHERE id = ?1", [id])
        .map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
fn delete_problem(database: State<Database>, id: String) -> Result<(), String> {
    let connection = database
        .connection
        .lock()
        .map_err(|error| error.to_string())?;
    connection
        .execute("DELETE FROM problems WHERE id = ?1", [id])
        .map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
fn create_practice_round(
    database: State<Database>,
    bank_id: String,
    mode: String,
    problem_ids: Vec<String>,
) -> Result<PracticeRound, String> {
    let mut connection = database
        .connection
        .lock()
        .map_err(|error| error.to_string())?;
    let transaction = connection
        .transaction()
        .map_err(|error| error.to_string())?;
    let mut targets = if mode == "manual" {
        problem_ids
    } else {
        let sql = if mode == "active" {
            "SELECT p.id FROM problems p JOIN question_sections s ON s.id=p.section_id
             WHERE s.question_bank_id=?1 AND p.review_status='active' ORDER BY s.sort_order,p.sort_order"
        } else {
            "SELECT p.id FROM problems p JOIN question_sections s ON s.id=p.section_id
             WHERE s.question_bank_id=?1 AND p.review_status!='excluded' ORDER BY s.sort_order,p.sort_order"
        };
        transaction
            .prepare(sql)
            .map_err(|error| error.to_string())?
            .query_map([&bank_id], |row| row.get(0))
            .map_err(|error| error.to_string())?
            .map(|row| row.map_err(|error| error.to_string()))
            .collect::<Result<Vec<String>, String>>()?
    };
    let mut seen = HashSet::new();
    targets.retain(|id| seen.insert(id.clone()));
    if targets.is_empty() {
        return Err("周回の対象問題がありません。".into());
    }
    let round_number: i64 = transaction
        .query_row(
            "SELECT COALESCE(MAX(round_number),0)+1 FROM practice_rounds WHERE question_bank_id=?1",
            [&bank_id],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;
    let round = PracticeRound {
        id: Uuid::new_v4().to_string(),
        question_bank_id: bank_id.clone(),
        round_number,
        title: None,
        started_at: now(),
        completed_at: None,
        target_problem_ids: targets.clone(),
    };
    transaction
        .execute(
            "INSERT INTO practice_rounds(id,question_bank_id,round_number,started_at) VALUES (?1,?2,?3,?4)",
            params![round.id, round.question_bank_id, round.round_number, round.started_at],
        )
        .map_err(|error| error.to_string())?;
    for (order, problem_id) in targets.iter().enumerate() {
        transaction
            .execute(
                "INSERT INTO round_target_problems(round_id,problem_id,sort_order) VALUES (?1,?2,?3)",
                params![round.id, problem_id, order as i64],
            )
            .map_err(|error| error.to_string())?;
    }
    transaction.commit().map_err(|error| error.to_string())?;
    Ok(round)
}

#[tauri::command]
fn complete_practice_round(database: State<Database>, round_id: String) -> Result<(), String> {
    let connection = database
        .connection
        .lock()
        .map_err(|error| error.to_string())?;
    connection
        .execute(
            "UPDATE practice_rounds SET completed_at=?1 WHERE id=?2 AND completed_at IS NULL",
            params![now(), round_id],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

fn validate_attempt(transaction: &Transaction, input: &AttemptInput) -> Result<(i64, i64), String> {
    let earned = milli(input.earned_score)?;
    let max = milli(input.max_score)?;
    if max < 1000 || earned < 0 || earned > max {
        return Err("得点は0以上かつ満点以下、満点は1以上にしてください。".into());
    }
    if let Some(confidence) = &input.confidence {
        if !["high", "medium", "low"].contains(&confidence.as_str()) {
            return Err("確信度が不正です。".into());
        }
    }
    let problem_exists: bool = transaction
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM problems WHERE id=?1)",
            [&input.problem_id],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;
    let round_exists: bool = transaction
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM practice_rounds WHERE id=?1)",
            [&input.round_id],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;
    if !problem_exists || !round_exists {
        return Err("問題または周回が見つかりません。".into());
    }
    Ok((earned, max))
}

fn next_attempt_number(transaction: &Transaction, problem_id: &str) -> Result<i64, String> {
    transaction
        .query_row(
            "SELECT COALESCE(MAX(attempt_number), 0) + 1
             FROM problem_attempts WHERE problem_id = ?1",
            [problem_id],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())
}

fn create_attempt_transaction(
    transaction: &Transaction,
    input: &AttemptInput,
) -> Result<ProblemAttempt, String> {
    let (earned, max) = validate_attempt(transaction, input)?;
    let attempt_number = next_attempt_number(transaction, &input.problem_id)?;
    let attempt = ProblemAttempt {
        id: input
            .id
            .clone()
            .unwrap_or_else(|| Uuid::new_v4().to_string()),
        problem_id: input.problem_id.clone(),
        round_id: input.round_id.clone(),
        answered_at: input.answered_at.clone(),
        attempt_number,
        earned_score: input.earned_score,
        max_score: input.max_score,
        confidence: input.confidence.clone(),
        note: input.note.clone(),
        user_answer: input.user_answer.clone(),
    };
    transaction
        .execute(
            "INSERT INTO problem_attempts(
               id,problem_id,round_id,answered_at,attempt_number,
               earned_score_milli,max_score_milli,confidence,note,user_answer
             ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)",
            params![
                attempt.id,
                attempt.problem_id,
                attempt.round_id,
                attempt.answered_at,
                attempt.attempt_number,
                earned,
                max,
                attempt.confidence,
                attempt.note,
                attempt.user_answer
            ],
        )
        .map_err(|error| error.to_string())?;
    transaction
        .execute(
            "INSERT OR IGNORE INTO round_target_problems(round_id,problem_id,sort_order)
             VALUES (
               ?1,
               ?2,
               COALESCE(
                 (SELECT MAX(sort_order) + 1 FROM round_target_problems WHERE round_id = ?1),
                 0
               )
             )",
            params![input.round_id, input.problem_id],
        )
        .map_err(|error| error.to_string())?;
    if let Some(status) = &input.next_review_status {
        transaction
            .execute(
                "UPDATE problems SET review_status=?1 WHERE id=?2",
                params![status, input.problem_id],
            )
            .map_err(|error| error.to_string())?;
    }
    Ok(attempt)
}

#[tauri::command]
fn create_attempt(
    database: State<Database>,
    input: AttemptInput,
) -> Result<ProblemAttempt, String> {
    let mut connection = database
        .connection
        .lock()
        .map_err(|error| error.to_string())?;
    let transaction = connection
        .transaction()
        .map_err(|error| error.to_string())?;
    let attempt = create_attempt_transaction(&transaction, &input)?;
    transaction.commit().map_err(|error| error.to_string())?;
    Ok(attempt)
}

#[tauri::command]
fn update_attempt(
    database: State<Database>,
    id: String,
    input: AttemptInput,
) -> Result<ProblemAttempt, String> {
    let mut connection = database
        .connection
        .lock()
        .map_err(|error| error.to_string())?;
    let transaction = connection
        .transaction()
        .map_err(|error| error.to_string())?;
    let (earned, max) = validate_attempt(&transaction, &input)?;
    let attempt_number: i64 = transaction
        .query_row(
            "SELECT attempt_number FROM problem_attempts WHERE id = ?1",
            [&id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| error.to_string())?
        .ok_or("編集する解答履歴が見つかりません。")?;
    let answered_at = input.answered_at.clone();
    let changed = transaction
        .execute(
            "UPDATE problem_attempts SET problem_id=?1,round_id=?2,answered_at=?3,earned_score_milli=?4,
             max_score_milli=?5,confidence=?6,note=?7,user_answer=?8 WHERE id=?9",
            params![input.problem_id,input.round_id,answered_at,earned,max,input.confidence,input.note,input.user_answer,id],
        )
        .map_err(|error| error.to_string())?;
    if changed == 0 {
        return Err("編集する解答履歴が見つかりません。".into());
    }
    transaction.commit().map_err(|error| error.to_string())?;
    Ok(ProblemAttempt {
        id,
        problem_id: input.problem_id,
        round_id: input.round_id,
        answered_at,
        attempt_number,
        earned_score: input.earned_score,
        max_score: input.max_score,
        confidence: input.confidence,
        note: input.note,
        user_answer: input.user_answer,
    })
}

#[tauri::command]
fn delete_attempt(database: State<Database>, id: String) -> Result<(), String> {
    let connection = database
        .connection
        .lock()
        .map_err(|error| error.to_string())?;
    connection
        .execute("DELETE FROM problem_attempts WHERE id=?1", [id])
        .map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
fn update_problem_statuses(
    database: State<Database>,
    problem_ids: Vec<String>,
    status: String,
) -> Result<(), String> {
    if !["active", "completed", "paused", "excluded"].contains(&status.as_str()) {
        return Err("復習状態が不正です。".into());
    }
    let mut connection = database
        .connection
        .lock()
        .map_err(|error| error.to_string())?;
    let transaction = connection
        .transaction()
        .map_err(|error| error.to_string())?;
    for id in problem_ids {
        transaction
            .execute(
                "UPDATE problems SET review_status=?1 WHERE id=?2",
                params![status, id],
            )
            .map_err(|error| error.to_string())?;
    }
    transaction.commit().map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
async fn invoke_anki_connect(action: String, params: Value) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || invoke_anki_connect_blocking(action, params))
        .await
        .map_err(|error| format!("AnkiConnect通信タスクが失敗しました: {error}"))?
}

fn invoke_anki_connect_blocking(action: String, params: Value) -> Result<Value, String> {
    let address = ("127.0.0.1", 8765)
        .to_socket_addrs()
        .map_err(|error| format!("AnkiConnectのアドレスを解決できませんでした: {error}"))?
        .next()
        .ok_or("AnkiConnectのアドレスを解決できませんでした。")?;
    let timeout = Duration::from_secs(10);
    let mut stream = TcpStream::connect_timeout(&address, timeout)
        .map_err(|error| format!("AnkiConnectへ接続できませんでした: {error}"))?;
    stream
        .set_read_timeout(Some(Duration::from_secs(60)))
        .map_err(|error| error.to_string())?;
    stream
        .set_write_timeout(Some(timeout))
        .map_err(|error| error.to_string())?;

    let body = serde_json::json!({ "action": action, "version": 6, "params": params }).to_string();
    let request = format!(
        "POST / HTTP/1.1\r\nHost: 127.0.0.1:8765\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        body.len(),
        body
    );
    stream
        .write_all(request.as_bytes())
        .map_err(|error| format!("AnkiConnectへの送信に失敗しました: {error}"))?;

    let mut response = Vec::new();
    stream
        .read_to_end(&mut response)
        .map_err(|error| format!("AnkiConnectからの応答を受信できませんでした: {error}"))?;
    let header_end = response
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .ok_or("AnkiConnectから不正なHTTP応答を受信しました。")?;
    let headers = String::from_utf8_lossy(&response[..header_end]);
    if !headers.starts_with("HTTP/1.1 200") && !headers.starts_with("HTTP/1.0 200") {
        let status = headers.lines().next().unwrap_or("HTTPエラー");
        return Err(format!("AnkiConnectがエラーを返しました: {status}"));
    }
    serde_json::from_slice(&response[header_end + 4..])
        .map_err(|error| format!("AnkiConnectのJSON応答を読み取れませんでした: {error}"))
}

#[cfg(test)]
mod backup_tests {
    use super::*;

    fn temporary_database(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!("goalforge-{name}-{}.sqlite", Uuid::new_v4()))
    }

    fn remove_database(path: &Path) {
        let _ = fs::remove_file(path);
        let _ = fs::remove_file(format!("{}-wal", path.to_string_lossy()));
        let _ = fs::remove_file(format!("{}-shm", path.to_string_lossy()));
    }

    #[test]
    fn full_backup_and_restore_preserves_all_data_groups() {
        let source_path = temporary_database("source");
        let backup_path = temporary_database("backup");
        let mut source = initialize_database(&source_path).expect("source database");
        source
            .execute(
                "INSERT INTO app_state(key,value_json,updated_at) VALUES ('main',?1,?2)",
                params![
                    serde_json::json!({
                        "goals": [{"id": "goal-1"}],
                        "studyPlans": [{"id": "plan-1"}]
                    })
                    .to_string(),
                    now()
                ],
            )
            .expect("app state");
        source
            .execute(
                "INSERT INTO materials(id,title,created_at,updated_at) VALUES ('material-1','教材',?1,?1)",
                [now()],
            )
            .expect("material");
        source
            .execute(
                "INSERT INTO question_banks(id,material_id,title,created_at,updated_at)
                 VALUES ('bank-1','material-1','教材',?1,?1)",
                [now()],
            )
            .expect("bank");
        source
            .execute(
                "INSERT INTO question_sections(id,question_bank_id,title,sort_order,evaluation_type,is_mock_exam_section)
                 VALUES ('section-1','bank-1','セクション',0,'binary',0)",
                [],
            )
            .expect("section");
        source
            .execute(
                "INSERT INTO problems(id,section_id,number,title,sort_order,default_max_score_milli,review_status)
                 VALUES ('problem-1','section-1','1','問題',0,1000,'active')",
                [],
            )
            .expect("problem");
        source
            .execute(
                "INSERT INTO practice_rounds(id,question_bank_id,round_number,started_at)
                 VALUES ('round-1','bank-1',1,?1)",
                [now()],
            )
            .expect("round");
        source
            .execute(
                "INSERT INTO round_target_problems(round_id,problem_id,sort_order)
                 VALUES ('round-1','problem-1',0)",
                [],
            )
            .expect("round target");
        source
            .execute(
                "INSERT INTO problem_attempts(
                    id,problem_id,round_id,answered_at,attempt_number,earned_score_milli,max_score_milli
                 ) VALUES ('attempt-1','problem-1','round-1',?1,1,1000,1000)",
                [now()],
            )
            .expect("attempt");

        let expected = database_summary(&source).expect("source summary");
        let mut backup = Connection::open(&backup_path).expect("backup database");
        online_backup(&source, &mut backup).expect("online backup");
        finalize_backup_file(&backup).expect("finalize backup");
        let backup_journal_mode: String = backup
            .query_row("PRAGMA journal_mode", [], |row| row.get(0))
            .expect("backup journal mode");
        assert_eq!(backup_journal_mode, "delete");
        assert_eq!(
            database_summary(&backup).expect("backup summary").materials,
            1
        );

        source
            .execute("DELETE FROM materials", [])
            .expect("mutate source");
        online_backup(&backup, &mut source).expect("online restore");
        configure_database(&source).expect("reconfigure");
        validate_goalforge_database(&source).expect("restored integrity");
        check_foreign_keys(&source).expect("restored foreign keys");
        let restored = database_summary(&source).expect("restored summary");

        assert_eq!(restored.materials, expected.materials);
        assert_eq!(restored.sections, expected.sections);
        assert_eq!(restored.problems, expected.problems);
        assert_eq!(restored.attempts, expected.attempts);
        assert_eq!(restored.rounds, expected.rounds);
        assert_eq!(restored.round_targets, expected.round_targets);
        assert_eq!(restored.custom_metrics, expected.custom_metrics);
        assert_eq!(restored.goals, expected.goals);
        assert_eq!(restored.study_plans, expected.study_plans);
        assert_eq!(restored.schema_version, CURRENT_SCHEMA_VERSION);

        drop(backup);
        drop(source);
        remove_database(&backup_path);
        remove_database(&source_path);
    }

    #[test]
    fn restored_old_database_is_migrated_to_current_schema() {
        let path = temporary_database("migration");
        let mut connection = Connection::open(&path).expect("old database");
        connection
            .execute_batch(include_str!("../migrations/001_initial.sql"))
            .expect("schema v1");
        connection
            .execute(
                "INSERT INTO schema_migrations(version,applied_at) VALUES (1,?1)",
                [now()],
            )
            .expect("migration marker");

        apply_migrations(&mut connection).expect("apply migrations");
        validate_goalforge_database(&connection).expect("migrated integrity");
        check_foreign_keys(&connection).expect("migrated foreign keys");
        let version: i64 = connection
            .query_row("SELECT MAX(version) FROM schema_migrations", [], |row| {
                row.get(0)
            })
            .expect("schema version");
        let supplemental_exists: bool = connection
            .query_row(
                "SELECT EXISTS(
                    SELECT 1 FROM pragma_table_info('problems') WHERE name='supplemental_info'
                 )",
                [],
                |row| row.get(0),
            )
            .expect("supplemental column");
        assert_eq!(version, CURRENT_SCHEMA_VERSION);
        assert!(supplemental_exists);

        drop(connection);
        remove_database(&path);
    }
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            migrate_legacy_bundle_database(&data_dir).map_err(std::io::Error::other)?;
            let path = data_dir.join(DATABASE_FILENAME);
            let connection = initialize_database(&path).map_err(std::io::Error::other)?;
            app.manage(Database {
                connection: Mutex::new(connection),
                path,
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            database_info,
            get_database_summary,
            create_database_backup,
            inspect_database_backup,
            restore_database_backup,
            load_app_state,
            save_app_state,
            migrate_legacy_state,
            get_question_banks,
            save_question_bank,
            get_custom_metric_summaries,
            list_custom_metrics,
            create_custom_metric,
            update_custom_metric,
            set_custom_metric_visibility,
            move_custom_metric,
            delete_custom_metric,
            restore_default_custom_metric,
            reset_custom_metrics,
            delete_question_bank,
            delete_question_section,
            delete_problem,
            create_practice_round,
            complete_practice_round,
            create_attempt,
            update_attempt,
            delete_attempt,
            update_problem_statuses,
            invoke_anki_connect
        ])
        .build(tauri::generate_context!())
        .expect("GoalForgeの起動に失敗しました")
        .run(|app_handle, event| {
            if matches!(
                event,
                tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit
            ) {
                if let Some(database) = app_handle.try_state::<Database>() {
                    if let Ok(connection) = database.connection.lock() {
                        let _ = connection.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);");
                    }
                }
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temporary_database_path(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!("goalforge-{label}-{}.sqlite", Uuid::new_v4()))
    }

    fn database_at_v3() -> Connection {
        let connection = Connection::open_in_memory().expect("in-memory database");
        connection
            .execute_batch(include_str!("../migrations/001_initial.sql"))
            .expect("migration 001");
        connection
            .execute_batch(include_str!(
                "../migrations/002_problem_details_and_confidence.sql"
            ))
            .expect("migration 002");
        connection
            .execute_batch(include_str!("../migrations/003_material_master.sql"))
            .expect("migration 003");
        connection
            .execute_batch(
                "INSERT INTO materials(id,title,created_at,updated_at)
                   VALUES ('material-1','教材','2026-01-01','2026-01-01');
                 INSERT INTO question_banks(id,material_id,title,created_at,updated_at)
                   VALUES ('bank-1','material-1','教材','2026-01-01','2026-01-01');
                 INSERT INTO question_sections(
                   id,question_bank_id,title,sort_order,evaluation_type,is_mock_exam_section
                 ) VALUES ('section-1','bank-1','大問1',0,'binary',0);
                 INSERT INTO problems(
                   id,section_id,number,sort_order,default_max_score_milli,review_status
                 ) VALUES ('problem-1','section-1','1',0,1000,'active');
                 INSERT INTO practice_rounds(id,question_bank_id,round_number,started_at)
                   VALUES ('round-1','bank-1',1,'2026-01-01');
                 INSERT INTO problem_attempts(
                   id,problem_id,round_id,answered_at,earned_score_milli,max_score_milli
                 ) VALUES
                   ('attempt-c','problem-1','round-1','2026-03-01',1000,1000),
                   ('attempt-b','problem-1','round-1','2026-01-01',0,1000),
                   ('attempt-a','problem-1','round-1','2026-01-01',1000,1000);",
            )
            .expect("fixture data");
        connection
    }

    #[test]
    fn migration_004_assigns_sequence_and_allows_unknown_dates() {
        let mut connection = database_at_v3();
        let before: i64 = connection
            .query_row("SELECT COUNT(*) FROM problem_attempts", [], |row| {
                row.get(0)
            })
            .expect("count before");
        let transaction = connection.transaction().expect("migration transaction");
        transaction
            .execute_batch(include_str!("../migrations/004_attempt_number.sql"))
            .expect("migration 004");
        transaction
            .execute_batch(include_str!("../migrations/006_answer_text.sql"))
            .expect("migration 006");
        transaction.commit().expect("commit migration");

        let after: i64 = connection
            .query_row("SELECT COUNT(*) FROM problem_attempts", [], |row| {
                row.get(0)
            })
            .expect("count after");
        assert_eq!(before, after);

        let migrated = connection
            .prepare(
                "SELECT id, attempt_number FROM problem_attempts
                 WHERE problem_id='problem-1' ORDER BY attempt_number",
            )
            .expect("prepare migrated attempts")
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
            })
            .expect("query migrated attempts")
            .collect::<Result<Vec<_>, _>>()
            .expect("collect migrated attempts");
        assert_eq!(
            migrated,
            vec![
                ("attempt-a".into(), 1),
                ("attempt-b".into(), 2),
                ("attempt-c".into(), 3),
            ]
        );

        connection
            .execute(
                "INSERT INTO problem_attempts(
                   id,problem_id,round_id,answered_at,attempt_number,
                   earned_score_milli,max_score_milli
                 ) VALUES ('attempt-null','problem-1','round-1',NULL,4,1000,1000)",
                [],
            )
            .expect("nullable answered_at");
        let answered_at: Option<String> = connection
            .query_row(
                "SELECT answered_at FROM problem_attempts WHERE id='attempt-null'",
                [],
                |row| row.get(0),
            )
            .expect("read nullable answered_at");
        assert_eq!(answered_at, None);

        let duplicate = connection.execute(
            "INSERT INTO problem_attempts(
               id,problem_id,round_id,answered_at,attempt_number,
               earned_score_milli,max_score_milli
             ) VALUES ('attempt-duplicate','problem-1','round-1',NULL,4,1000,1000)",
            [],
        );
        assert!(duplicate.is_err());

        let transaction = connection.transaction().expect("number transaction");
        assert_eq!(next_attempt_number(&transaction, "problem-1").unwrap(), 5);
        transaction.rollback().expect("rollback number transaction");

        let transaction = connection.transaction().expect("create transaction");
        let created = create_attempt_transaction(
            &transaction,
            &AttemptInput {
                id: Some("attempt-created".into()),
                problem_id: "problem-1".into(),
                round_id: "round-1".into(),
                answered_at: None,
                earned_score: 1.0,
                max_score: 1.0,
                confidence: Some("high".into()),
                note: None,
                user_answer: None,
                correct_answer: None,
                next_review_status: None,
            },
        )
        .expect("normal attempt creation");
        assert_eq!(created.attempt_number, 5);
        assert_eq!(created.answered_at, None);
        transaction.commit().expect("commit created attempt");
        let target_exists: bool = connection
            .query_row(
                "SELECT EXISTS(
                   SELECT 1 FROM round_target_problems
                   WHERE round_id='round-1' AND problem_id='problem-1'
                 )",
                [],
                |row| row.get(0),
            )
            .expect("round target after attempt creation");
        assert!(target_exists);

        let loaded = load_attempts(&connection, "problem-1").expect("load attempts");
        assert_eq!(
            loaded
                .iter()
                .map(|attempt| attempt.attempt_number)
                .collect::<Vec<_>>(),
            vec![5, 4, 3, 2, 1]
        );
        assert_eq!(loaded[1].answered_at, None);

        let integrity: String = connection
            .query_row("PRAGMA integrity_check", [], |row| row.get(0))
            .expect("integrity check");
        assert_eq!(integrity, "ok");
        let foreign_key_errors: i64 = connection
            .query_row("SELECT COUNT(*) FROM pragma_foreign_key_check", [], |row| {
                row.get(0)
            })
            .expect("foreign key check");
        assert_eq!(foreign_key_errors, 0);
    }

    #[test]
    fn new_database_applies_latest_migration() {
        let path = temporary_database_path("new-database");
        let connection = initialize_database(&path).expect("initialize new database");
        let version: i64 = connection
            .query_row("SELECT MAX(version) FROM schema_migrations", [], |row| {
                row.get(0)
            })
            .unwrap();
        let table_exists: bool = connection
            .query_row(
                "SELECT EXISTS(
                   SELECT 1 FROM sqlite_master
                   WHERE type='table' AND name='custom_metrics'
                 )",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(version, 6);
        assert!(table_exists);
        drop(connection);
        fs::remove_file(path).expect("remove test database");
    }

    #[test]
    fn existing_database_applies_latest_migrations_and_seeds_defaults() {
        let path = temporary_database_path("existing-database");
        let connection = Connection::open(&path).expect("existing database");
        connection
            .execute_batch(
                "PRAGMA foreign_keys = ON;
                 PRAGMA journal_mode = DELETE;",
            )
            .unwrap();
        connection
            .execute_batch(include_str!("../migrations/001_initial.sql"))
            .unwrap();
        connection
            .execute_batch(include_str!(
                "../migrations/002_problem_details_and_confidence.sql"
            ))
            .unwrap();
        connection
            .execute_batch(include_str!("../migrations/003_material_master.sql"))
            .unwrap();
        connection
            .execute_batch(include_str!("../migrations/004_attempt_number.sql"))
            .unwrap();
        connection
            .execute_batch(
                "INSERT INTO schema_migrations(version,applied_at) VALUES
                   (1,'2026-01-01'),(2,'2026-01-01'),(3,'2026-01-01'),(4,'2026-01-01');
                 INSERT INTO materials(id,title,created_at,updated_at)
                   VALUES ('material-existing','既存教材','2026-01-01','2026-01-01');
                 INSERT INTO question_banks(id,material_id,title,created_at,updated_at)
                   VALUES ('bank-existing','material-existing','既存教材','2026-01-01','2026-01-01');",
            )
            .unwrap();
        drop(connection);

        let connection = initialize_database(&path).expect("migrate existing database");
        let defaults: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM custom_metrics
                 WHERE question_bank_id='bank-existing'
                   AND origin='default'
                   AND deleted_at IS NULL",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let version: i64 = connection
            .query_row("SELECT MAX(version) FROM schema_migrations", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(defaults, 3);
        assert_eq!(version, 6);

        connection
            .execute("DELETE FROM materials WHERE id='material-existing'", [])
            .unwrap();
        let remaining: i64 = connection
            .query_row("SELECT COUNT(*) FROM custom_metrics", [], |row| row.get(0))
            .unwrap();
        assert_eq!(remaining, 0);
        drop(connection);
        fs::remove_file(path).expect("remove test database");
    }

    #[test]
    fn new_question_bank_gets_default_metrics() {
        let path = temporary_database_path("new-bank");
        let mut connection = initialize_database(&path).expect("initialize database");
        let transaction = connection.transaction().unwrap();
        save_bank_transaction(
            &transaction,
            &QuestionBank {
                id: "bank-new".into(),
                material_id: "material-new".into(),
                title: "新規教材".into(),
                sections: vec![],
                rounds: vec![],
            },
        )
        .unwrap();
        transaction.commit().unwrap();

        let transaction = connection.transaction().unwrap();
        save_bank_transaction(
            &transaction,
            &QuestionBank {
                id: "bank-new".into(),
                material_id: "material-new".into(),
                title: "更新した教材名".into(),
                sections: vec![],
                rounds: vec![],
            },
        )
        .unwrap();
        transaction.commit().unwrap();

        let records = custom_metrics::load_custom_metrics(&connection, "bank-new", false).unwrap();
        assert_eq!(records.len(), 3);
        assert_eq!(
            records
                .iter()
                .map(|record| record.system_key.as_deref().unwrap())
                .collect::<Vec<_>>(),
            vec!["ever_correct", "ever_confident_correct", "multiple_correct"]
        );
        drop(connection);
        fs::remove_file(path).expect("remove test database");
    }
}
