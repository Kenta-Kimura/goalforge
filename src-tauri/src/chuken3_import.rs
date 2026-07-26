use super::{
    initialize_database, now, save_bank_transaction, Problem, QuestionBank, QuestionSection,
};
use rusqlite::{params, Connection, OpenFlags};
use serde::{Deserialize, Serialize};
use std::{fs, path::Path};

pub const MIGRATION_ID: &str = "import-chuken3-trainingbook-v1";
const WRITING_TITLE: &str = "《改訂版》合格奪取！中国語検定 3級 トレーニングブック 【筆記問題編】";
const LISTENING_TITLE: &str =
    "《改訂版》合格奪取！中国語検定 3級 トレーニングブック 【リスニング問題編】";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ImportPayload {
    migration_id: String,
    materials: Vec<ImportMaterial>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ImportMaterial {
    key: String,
    title: String,
    max_answer_column: i64,
    sections: Vec<ImportSection>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ImportSection {
    key: String,
    title: String,
    problems: Vec<ImportProblem>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ImportProblem {
    key: String,
    number: String,
    title: String,
    attempts: Vec<ImportAttempt>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ImportAttempt {
    source_answer_column: i64,
    answered_at: Option<String>,
    value: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportReport {
    pub materials: i64,
    pub sections: i64,
    pub problems: i64,
    pub attempts: i64,
    pub rounds: i64,
    pub null_answered_at: i64,
    pub value_0: i64,
    pub value_1: i64,
    pub value_2: i64,
    pub migration_records: i64,
    pub sequence_errors: i64,
    pub integrity_check: String,
    pub foreign_key_errors: i64,
}

pub fn preflight(database_path: &Path) -> Result<(), String> {
    let connection = Connection::open_with_flags(database_path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|error| error.to_string())?;
    configure_read_connection(&connection)?;
    check_database_ready(&connection)
}

pub fn apply(
    database_path: &Path,
    backup_path: &Path,
    payload_path: &Path,
) -> Result<ImportReport, String> {
    verify_backup(database_path, backup_path)?;
    let payload: ImportPayload =
        serde_json::from_slice(&fs::read(payload_path).map_err(|error| error.to_string())?)
            .map_err(|error| error.to_string())?;
    validate_payload(&payload)?;

    let mut connection = initialize_database(&database_path.to_path_buf())?;
    check_database_ready(&connection)?;
    let transaction = connection
        .transaction()
        .map_err(|error| error.to_string())?;
    let imported_at = now();

    for material in &payload.materials {
        let bank = to_question_bank(material);
        save_bank_transaction(&transaction, &bank)?;

        for answer_column in 1..=material.max_answer_column {
            let round_id = format!("chuken3-{}-round-{}", material.key, answer_column);
            let targets = material
                .sections
                .iter()
                .flat_map(|section| section.problems.iter())
                .filter(|problem| {
                    problem
                        .attempts
                        .iter()
                        .any(|attempt| attempt.source_answer_column == answer_column)
                })
                .collect::<Vec<_>>();
            if targets.is_empty() {
                return Err(format!(
                    "{}の回答{}にAttemptがありません。",
                    material.title, answer_column
                ));
            }
            transaction
                .execute(
                    "INSERT INTO practice_rounds(
                       id,question_bank_id,round_number,title,started_at,completed_at
                     ) VALUES (?1,?2,?3,?4,?5,?5)",
                    params![
                        round_id,
                        format!("chuken3-{}-bank", material.key),
                        answer_column,
                        format!("Numbers移行 回答{}", answer_column),
                        imported_at
                    ],
                )
                .map_err(|error| error.to_string())?;
            for (order, problem) in targets.iter().enumerate() {
                transaction
                    .execute(
                        "INSERT INTO round_target_problems(round_id,problem_id,sort_order)
                         VALUES (?1,?2,?3)",
                        params![
                            round_id,
                            format!("chuken3-{}-problem-{}", material.key, problem.key),
                            order as i64
                        ],
                    )
                    .map_err(|error| error.to_string())?;
            }
        }

        for section in &material.sections {
            for problem in &section.problems {
                let mut attempts = problem.attempts.iter().collect::<Vec<_>>();
                attempts.sort_by_key(|attempt| attempt.source_answer_column);
                for (index, attempt) in attempts.iter().enumerate() {
                    let (earned, confidence): (i64, Option<&str>) = match attempt.value {
                        0 => (0, None),
                        1 => (1000, Some("low")),
                        2 => (1000, Some("high")),
                        value => return Err(format!("不正な回答値です: {}", value)),
                    };
                    let problem_id = format!("chuken3-{}-problem-{}", material.key, problem.key);
                    transaction
                        .execute(
                            "INSERT INTO problem_attempts(
                               id,problem_id,round_id,answered_at,attempt_number,
                               earned_score_milli,max_score_milli,confidence,note
                             ) VALUES (?1,?2,?3,?4,?5,?6,1000,?7,NULL)",
                            params![
                                format!(
                                    "chuken3-{}-attempt-{}-{}",
                                    material.key, problem.key, attempt.source_answer_column
                                ),
                                problem_id,
                                format!(
                                    "chuken3-{}-round-{}",
                                    material.key, attempt.source_answer_column
                                ),
                                attempt.answered_at,
                                index as i64 + 1,
                                earned,
                                confidence
                            ],
                        )
                        .map_err(|error| error.to_string())?;
                }
            }
        }
    }

    transaction
        .execute(
            "INSERT INTO data_migrations(migration_key,version,completed_at,details_json)
             VALUES (?1,1,?2,?3)",
            params![
                MIGRATION_ID,
                imported_at,
                serde_json::json!({
                    "source": "中国語検定2級.numbers",
                    "sheets": ["筆記（3級）", "リスニング（3級）"],
                    "attemptNumber": "non-empty answers ordered left-to-right",
                    "roundNumber": "original answer column"
                })
                .to_string()
            ],
        )
        .map_err(|error| error.to_string())?;

    let report = collect_report(&transaction)?;
    validate_report(&report)?;
    transaction.commit().map_err(|error| error.to_string())?;
    Ok(report)
}

fn configure_read_connection(connection: &Connection) -> Result<(), String> {
    connection
        .execute_batch("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;")
        .map_err(|error| error.to_string())
}

fn check_database_ready(connection: &Connection) -> Result<(), String> {
    let integrity: String = connection
        .query_row("PRAGMA integrity_check", [], |row| row.get(0))
        .map_err(|error| error.to_string())?;
    if integrity != "ok" {
        return Err(format!("integrity_checkに失敗しました: {}", integrity));
    }
    let foreign_key_errors: i64 = connection
        .query_row("SELECT COUNT(*) FROM pragma_foreign_key_check", [], |row| {
            row.get(0)
        })
        .map_err(|error| error.to_string())?;
    if foreign_key_errors != 0 {
        return Err(format!(
            "foreign_key_checkに{}件のエラーがあります。",
            foreign_key_errors
        ));
    }
    let already_done: bool = connection
        .query_row(
            "SELECT EXISTS(
               SELECT 1 FROM data_migrations WHERE migration_key=?1
             )",
            [MIGRATION_ID],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;
    if already_done {
        return Err(format!("Migration {} は実行済みです。", MIGRATION_ID));
    }
    let reserved_ids: i64 = connection
        .query_row(
            "SELECT
               (SELECT COUNT(*) FROM materials WHERE id LIKE 'chuken3-%')
               + (SELECT COUNT(*) FROM question_banks WHERE id LIKE 'chuken3-%')
               + (SELECT COUNT(*) FROM question_sections WHERE id LIKE 'chuken3-%')
               + (SELECT COUNT(*) FROM problems WHERE id LIKE 'chuken3-%')
               + (SELECT COUNT(*) FROM practice_rounds WHERE id LIKE 'chuken3-%')
               + (SELECT COUNT(*) FROM problem_attempts WHERE id LIKE 'chuken3-%')",
            [],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;
    if reserved_ids != 0 {
        return Err(format!(
            "移行用予約IDに一致する既存データが{}件あります。",
            reserved_ids
        ));
    }
    for title in [WRITING_TITLE, LISTENING_TITLE] {
        let exists: bool = connection
            .query_row(
                "SELECT EXISTS(
                   SELECT 1 FROM materials WHERE title=?1
                   UNION ALL
                   SELECT 1 FROM question_banks WHERE title=?1
                 )",
                [title],
                |row| row.get(0),
            )
            .map_err(|error| error.to_string())?;
        if exists {
            return Err(format!("同名教材が存在します: {}", title));
        }
    }
    Ok(())
}

fn verify_backup(database_path: &Path, backup_path: &Path) -> Result<(), String> {
    if !backup_path.is_file() {
        return Err(format!(
            "SQLiteバックアップがありません: {}",
            backup_path.display()
        ));
    }
    if database_path == backup_path {
        return Err("バックアップ先が実DBと同じです。".into());
    }
    let backup = Connection::open_with_flags(backup_path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|error| error.to_string())?;
    let integrity: String = backup
        .query_row("PRAGMA integrity_check", [], |row| row.get(0))
        .map_err(|error| error.to_string())?;
    if integrity != "ok" {
        return Err(format!(
            "バックアップのintegrity_checkに失敗しました: {integrity}"
        ));
    }
    Ok(())
}

fn validate_payload(payload: &ImportPayload) -> Result<(), String> {
    if payload.migration_id != MIGRATION_ID {
        return Err("Migration IDが一致しません。".into());
    }
    if payload.materials.len() != 2
        || payload.materials[0].title != WRITING_TITLE
        || payload.materials[1].title != LISTENING_TITLE
    {
        return Err("対象教材が一致しません。".into());
    }
    let sections = payload
        .materials
        .iter()
        .map(|material| material.sections.len())
        .sum::<usize>();
    let problems = payload
        .materials
        .iter()
        .flat_map(|material| material.sections.iter())
        .map(|section| section.problems.len())
        .sum::<usize>();
    let attempts = payload
        .materials
        .iter()
        .flat_map(|material| material.sections.iter())
        .flat_map(|section| section.problems.iter())
        .map(|problem| problem.attempts.len())
        .sum::<usize>();
    if sections != 41 || problems != 661 || attempts != 1446 {
        return Err(format!(
            "元データ件数が一致しません: Section={sections}, Problem={problems}, Attempt={attempts}"
        ));
    }
    if payload.materials[0].sections.len() != 30
        || payload.materials[1].sections.len() != 11
        || payload.materials[0].max_answer_column != 3
        || payload.materials[1].max_answer_column != 6
    {
        return Err("教材別Section数または回答列数が一致しません。".into());
    }
    for material in &payload.materials {
        for section in &material.sections {
            for problem in &section.problems {
                let mut previous = 0;
                for attempt in &problem.attempts {
                    if attempt.source_answer_column <= previous
                        || attempt.source_answer_column > material.max_answer_column
                        || ![0, 1, 2].contains(&attempt.value)
                    {
                        return Err(format!("Problem {} の回答履歴が不正です。", problem.key));
                    }
                    previous = attempt.source_answer_column;
                }
            }
        }
    }
    Ok(())
}

fn to_question_bank(material: &ImportMaterial) -> QuestionBank {
    let bank_id = format!("chuken3-{}-bank", material.key);
    QuestionBank {
        id: bank_id.clone(),
        material_id: format!("chuken3-{}-material", material.key),
        title: material.title.clone(),
        rounds: vec![],
        sections: material
            .sections
            .iter()
            .enumerate()
            .map(|(section_order, section)| {
                let section_id = format!("chuken3-{}-section-{}", material.key, section.key);
                QuestionSection {
                    id: section_id.clone(),
                    question_bank_id: bank_id.clone(),
                    title: section.title.clone(),
                    order: section_order as i64,
                    evaluation_type: "binary".into(),
                    is_mock_exam_section: false,
                    problems: section
                        .problems
                        .iter()
                        .enumerate()
                        .map(|(problem_order, problem)| Problem {
                            id: format!("chuken3-{}-problem-{}", material.key, problem.key),
                            section_id: section_id.clone(),
                            number: problem.number.clone(),
                            title: Some(problem.title.clone()),
                            order: problem_order as i64,
                            default_max_score: 1.0,
                            evaluation_type_override: Some("binary".into()),
                            supplemental_info: None,
                            review_status: "active".into(),
                            attempts: vec![],
                        })
                        .collect(),
                }
            })
            .collect(),
    }
}

fn collect_report(connection: &Connection) -> Result<ImportReport, String> {
    let scalar = |sql: &str| {
        connection
            .query_row(sql, [], |row| row.get::<_, i64>(0))
            .map_err(|error| error.to_string())
    };
    let integrity_check = connection
        .query_row("PRAGMA integrity_check", [], |row| row.get(0))
        .map_err(|error| error.to_string())?;
    Ok(ImportReport {
        materials: scalar("SELECT COUNT(*) FROM materials WHERE id LIKE 'chuken3-%-material'")?,
        sections: scalar(
            "SELECT COUNT(*) FROM question_sections WHERE id LIKE 'chuken3-%-section-%'",
        )?,
        problems: scalar("SELECT COUNT(*) FROM problems WHERE id LIKE 'chuken3-%-problem-%'")?,
        attempts: scalar(
            "SELECT COUNT(*) FROM problem_attempts WHERE id LIKE 'chuken3-%-attempt-%'",
        )?,
        rounds: scalar("SELECT COUNT(*) FROM practice_rounds WHERE id LIKE 'chuken3-%-round-%'")?,
        null_answered_at: scalar(
            "SELECT COUNT(*) FROM problem_attempts
             WHERE id LIKE 'chuken3-%-attempt-%' AND answered_at IS NULL",
        )?,
        value_0: scalar(
            "SELECT COUNT(*) FROM problem_attempts
             WHERE id LIKE 'chuken3-%-attempt-%' AND earned_score_milli=0 AND confidence IS NULL",
        )?,
        value_1: scalar(
            "SELECT COUNT(*) FROM problem_attempts
             WHERE id LIKE 'chuken3-%-attempt-%' AND earned_score_milli=1000 AND confidence='low'",
        )?,
        value_2: scalar(
            "SELECT COUNT(*) FROM problem_attempts
             WHERE id LIKE 'chuken3-%-attempt-%' AND earned_score_milli=1000 AND confidence='high'",
        )?,
        migration_records: scalar(&format!(
            "SELECT COUNT(*) FROM data_migrations WHERE migration_key='{}'",
            MIGRATION_ID
        ))?,
        sequence_errors: scalar(
            "SELECT COUNT(*) FROM (
               SELECT problem_id,COUNT(*) AS count_attempts,
                      MIN(attempt_number) AS min_number,
                      MAX(attempt_number) AS max_number,
                      COUNT(DISTINCT attempt_number) AS distinct_numbers
               FROM problem_attempts
               WHERE id LIKE 'chuken3-%-attempt-%'
               GROUP BY problem_id
               HAVING min_number<>1 OR max_number<>count_attempts
                      OR distinct_numbers<>count_attempts
             )",
        )?,
        integrity_check,
        foreign_key_errors: scalar("SELECT COUNT(*) FROM pragma_foreign_key_check")?,
    })
}

fn validate_report(report: &ImportReport) -> Result<(), String> {
    let valid = report.materials == 2
        && report.sections == 41
        && report.problems == 661
        && report.attempts == 1446
        && report.rounds == 9
        && report.null_answered_at == 300
        && report.value_0 == 501
        && report.value_1 == 343
        && report.value_2 == 602
        && report.migration_records == 1
        && report.sequence_errors == 0
        && report.integrity_check == "ok"
        && report.foreign_key_errors == 0;
    if !valid {
        return Err(format!("移行後検証に失敗しました: {report:?}"));
    }
    Ok(())
}
