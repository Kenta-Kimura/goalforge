use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{collections::HashSet, fs, path::PathBuf, sync::Mutex};
use tauri::{Manager, State};
use uuid::Uuid;

struct Database {
    connection: Mutex<Connection>,
    path: PathBuf,
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
    review_status: String,
    attempts: Vec<ProblemAttempt>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ProblemAttempt {
    id: String,
    problem_id: String,
    round_id: String,
    answered_at: String,
    earned_score: f64,
    max_score: f64,
    confidence: Option<String>,
    note: Option<String>,
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

fn initialize_database(path: &PathBuf) -> Result<Connection, String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let mut connection = Connection::open(path).map_err(|error| error.to_string())?;
    connection
        .execute_batch(
            "PRAGMA foreign_keys = ON;
             PRAGMA journal_mode = WAL;
             PRAGMA synchronous = NORMAL;
             PRAGMA busy_timeout = 5000;",
        )
        .map_err(|error| error.to_string())?;
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
    Ok(connection)
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
                    evaluation_type_override, review_status, supplemental_info
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
            review_status,
        });
    }
    Ok(problems)
}

fn load_attempts(connection: &Connection, problem_id: &str) -> Result<Vec<ProblemAttempt>, String> {
    let mut statement = connection
        .prepare(
            "SELECT id, round_id, answered_at, earned_score_milli, max_score_milli, confidence, note
             FROM problem_attempts WHERE problem_id = ?1 ORDER BY answered_at DESC, id DESC",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([problem_id], |row| {
            Ok(ProblemAttempt {
                id: row.get(0)?,
                problem_id: problem_id.into(),
                round_id: row.get(1)?,
                answered_at: row.get(2)?,
                earned_score: score(row.get(3)?),
                max_score: score(row.get(4)?),
                confidence: row.get(5)?,
                note: row.get(6)?,
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
        .ok_or("保存した問題集を取得できません。".into())
}

fn save_bank_transaction(transaction: &Transaction, bank: &QuestionBank) -> Result<(), String> {
    if bank.title.trim().is_empty() {
        return Err("問題集名を入力してください。".into());
    }
    let timestamp = now();
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
                                          evaluation_type_override, review_status, supplemental_info)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
                     ON CONFLICT(id) DO UPDATE SET section_id=excluded.section_id, number=excluded.number,
                       title=excluded.title, sort_order=excluded.sort_order,
                       default_max_score_milli=excluded.default_max_score_milli,
                       evaluation_type_override=excluded.evaluation_type_override,
                       review_status=excluded.review_status, supplemental_info=excluded.supplemental_info",
                    params![
                        problem.id, section.id, problem.number, problem.title, problem.order,
                        max_score, problem.evaluation_type_override, problem.review_status, problem.supplemental_info
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
    let (earned, max) = validate_attempt(&transaction, &input)?;
    let attempt = ProblemAttempt {
        id: input
            .id
            .clone()
            .unwrap_or_else(|| Uuid::new_v4().to_string()),
        problem_id: input.problem_id.clone(),
        round_id: input.round_id.clone(),
        answered_at: input.answered_at.clone().unwrap_or_else(now),
        earned_score: input.earned_score,
        max_score: input.max_score,
        confidence: input.confidence.clone(),
        note: input.note.clone(),
    };
    transaction
        .execute(
            "INSERT INTO problem_attempts(id,problem_id,round_id,answered_at,earned_score_milli,max_score_milli,confidence,note)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8)",
            params![attempt.id,attempt.problem_id,attempt.round_id,attempt.answered_at,earned,max,attempt.confidence,attempt.note],
        )
        .map_err(|error| error.to_string())?;
    if let Some(status) = input.next_review_status {
        transaction
            .execute(
                "UPDATE problems SET review_status=?1 WHERE id=?2",
                params![status, input.problem_id],
            )
            .map_err(|error| error.to_string())?;
    }
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
    let answered_at = input.answered_at.clone().unwrap_or_else(now);
    let changed = transaction
        .execute(
            "UPDATE problem_attempts SET problem_id=?1,round_id=?2,answered_at=?3,earned_score_milli=?4,
             max_score_milli=?5,confidence=?6,note=?7 WHERE id=?8",
            params![input.problem_id,input.round_id,answered_at,earned,max,input.confidence,input.note,id],
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
        earned_score: input.earned_score,
        max_score: input.max_score,
        confidence: input.confidence,
        note: input.note,
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

pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            let path = data_dir.join("goalforge.sqlite");
            let connection = initialize_database(&path).map_err(std::io::Error::other)?;
            app.manage(Database {
                connection: Mutex::new(connection),
                path,
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            database_info,
            load_app_state,
            save_app_state,
            migrate_legacy_state,
            get_question_banks,
            save_question_bank,
            delete_question_bank,
            delete_question_section,
            delete_problem,
            create_practice_round,
            complete_practice_round,
            create_attempt,
            update_attempt,
            delete_attempt,
            update_problem_statuses
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
