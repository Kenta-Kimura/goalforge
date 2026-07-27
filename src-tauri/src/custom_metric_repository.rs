use crate::custom_metrics::{
    load_custom_metrics, save_custom_metric, soft_delete_custom_metric, CustomMetricRecord,
};
use rusqlite::{params, Connection, OptionalExtension};

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ProblemRow {
    pub id: String,
    pub review_status: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ProblemAttemptRow {
    pub id: String,
    pub problem_id: String,
    pub round_id: String,
    pub round_number: Option<i64>,
    pub answered_at: Option<String>,
    pub attempt_number: i64,
    pub earned_score_milli: i64,
    pub max_score_milli: i64,
    pub confidence: Option<String>,
}

pub(crate) fn load_metric_problems(
    connection: &Connection,
    question_bank_id: &str,
) -> Result<Vec<ProblemRow>, String> {
    let mut statement = connection
        .prepare(
            "SELECT problems.id, problems.review_status
             FROM problems
             JOIN question_sections
               ON question_sections.id = problems.section_id
             WHERE question_sections.question_bank_id = ?1
             ORDER BY question_sections.sort_order, problems.sort_order, problems.id",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([question_bank_id], |row| {
            Ok(ProblemRow {
                id: row.get(0)?,
                review_status: row.get(1)?,
            })
        })
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    Ok(rows)
}

pub(crate) fn load_metric_attempts(
    connection: &Connection,
    question_bank_id: &str,
) -> Result<Vec<ProblemAttemptRow>, String> {
    let mut statement = connection
        .prepare(
            "SELECT problem_attempts.id,
                    problem_attempts.problem_id,
                    problem_attempts.round_id,
                    practice_rounds.round_number,
                    problem_attempts.answered_at,
                    problem_attempts.attempt_number,
                    problem_attempts.earned_score_milli,
                    problem_attempts.max_score_milli,
                    problem_attempts.confidence
             FROM problem_attempts
             JOIN problems ON problems.id = problem_attempts.problem_id
             JOIN question_sections ON question_sections.id = problems.section_id
             LEFT JOIN practice_rounds ON practice_rounds.id = problem_attempts.round_id
             WHERE question_sections.question_bank_id = ?1
             ORDER BY problem_attempts.problem_id, problem_attempts.attempt_number",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([question_bank_id], |row| {
            Ok(ProblemAttemptRow {
                id: row.get(0)?,
                problem_id: row.get(1)?,
                round_id: row.get(2)?,
                round_number: row.get(3)?,
                answered_at: row.get(4)?,
                attempt_number: row.get(5)?,
                earned_score_milli: row.get(6)?,
                max_score_milli: row.get(7)?,
                confidence: row.get(8)?,
            })
        })
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    Ok(rows)
}

pub(crate) fn load_metric_records(
    connection: &Connection,
    question_bank_id: &str,
) -> Result<Vec<CustomMetricRecord>, String> {
    // 非表示メトリクスも管理・集計に利用できるよう取得し、論理削除済みだけ除外する。
    load_custom_metrics(connection, question_bank_id, false)
}

pub(crate) fn list_custom_metric_records(
    connection: &Connection,
    question_bank_id: &str,
) -> Result<Vec<CustomMetricRecord>, String> {
    load_custom_metrics(connection, question_bank_id, false)
}

pub(crate) fn find_custom_metric_record(
    connection: &Connection,
    metric_id: &str,
    include_deleted: bool,
) -> Result<Option<CustomMetricRecord>, String> {
    let question_bank_id = connection
        .query_row(
            "SELECT question_bank_id FROM custom_metrics
             WHERE id = ?1 AND (?2 = 1 OR deleted_at IS NULL)",
            params![metric_id, include_deleted],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    let Some(question_bank_id) = question_bank_id else {
        return Ok(None);
    };
    Ok(
        load_custom_metrics(connection, &question_bank_id, include_deleted)?
            .into_iter()
            .find(|record| record.id == metric_id),
    )
}

pub(crate) fn persist_custom_metric_record(
    connection: &Connection,
    record: &CustomMetricRecord,
) -> Result<(), String> {
    save_custom_metric(connection, record)
}

pub(crate) fn update_custom_metric_visibility(
    connection: &Connection,
    metric_id: &str,
    is_visible: bool,
    updated_at: &str,
) -> Result<bool, String> {
    connection
        .execute(
            "UPDATE custom_metrics
             SET is_visible = ?2, updated_at = ?3
             WHERE id = ?1 AND deleted_at IS NULL",
            params![metric_id, is_visible, updated_at],
        )
        .map(|changed| changed > 0)
        .map_err(|error| error.to_string())
}

pub(crate) fn update_custom_metric_sort_orders(
    connection: &Connection,
    ordered_metric_ids: &[String],
    updated_at: &str,
) -> Result<(), String> {
    for (sort_order, metric_id) in ordered_metric_ids.iter().enumerate() {
        let changed = connection
            .execute(
                "UPDATE custom_metrics
                 SET sort_order = ?2, updated_at = ?3
                 WHERE id = ?1 AND deleted_at IS NULL",
                params![metric_id, sort_order as i32, updated_at],
            )
            .map_err(|error| error.to_string())?;
        if changed == 0 {
            return Err(format!("並び替えるメトリクスが見つかりません: {metric_id}"));
        }
    }
    Ok(())
}

pub(crate) fn logically_delete_custom_metric(
    connection: &Connection,
    metric_id: &str,
    updated_at: &str,
) -> Result<bool, String> {
    soft_delete_custom_metric(connection, metric_id, updated_at)
}
