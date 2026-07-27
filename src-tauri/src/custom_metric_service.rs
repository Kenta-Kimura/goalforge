use crate::{
    custom_metric_evaluator::{
        evaluate_metric, AttemptConfidence, MetricEvaluationError, Problem, ProblemAttempt,
        ProblemReviewStatus,
    },
    custom_metric_repository::{
        load_metric_attempts, load_metric_problems, load_metric_records, ProblemAttemptRow,
        ProblemRow,
    },
};
use rusqlite::Connection;
use std::collections::HashSet;
use thiserror::Error;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CustomMetricSummary {
    pub metric_id: String,
    pub metric_name: String,
    pub icon: Option<String>,
    pub matched_problem_ids: HashSet<String>,
    pub population_problem_ids: HashSet<String>,
}

#[derive(Debug, Error)]
pub enum CustomMetricServiceError {
    #[error("カスタムメトリクスのDB取得に失敗しました: {0}")]
    Repository(String),
    #[error("未知のProblem状態です: {0}")]
    InvalidReviewStatus(String),
    #[error("未知の確信度です: {0}")]
    InvalidConfidence(String),
    #[error("評価入力の数値が範囲外です: {0}")]
    NumericRange(String),
    #[error("保存済みカスタムメトリクスが不正です: {0}")]
    InvalidMetric(String),
    #[error("カスタムメトリクス評価に失敗しました: {0}")]
    Evaluation(#[from] MetricEvaluationError),
}

pub fn summarize_custom_metrics(
    connection: &Connection,
    question_bank_id: &str,
) -> Result<Vec<CustomMetricSummary>, CustomMetricServiceError> {
    let problem_rows = load_metric_problems(connection, question_bank_id)
        .map_err(CustomMetricServiceError::Repository)?;
    let attempt_rows = load_metric_attempts(connection, question_bank_id)
        .map_err(CustomMetricServiceError::Repository)?;
    let metric_records = load_metric_records(connection, question_bank_id)
        .map_err(CustomMetricServiceError::Repository)?;

    let problems = adapt_problems(problem_rows)?;
    let attempts = adapt_attempts(attempt_rows)?;
    metric_records
        .into_iter()
        .map(|record| {
            let metric = record
                .to_metric()
                .map_err(CustomMetricServiceError::InvalidMetric)?;
            let result =
                evaluate_metric(&problems, &attempts, &metric.definition, &metric.population)?;
            Ok(CustomMetricSummary {
                metric_id: metric.id,
                metric_name: metric.name,
                icon: metric.icon,
                matched_problem_ids: result.matched_problem_ids,
                population_problem_ids: result.population_problem_ids,
            })
        })
        .collect()
}

fn adapt_problems(rows: Vec<ProblemRow>) -> Result<Vec<Problem>, CustomMetricServiceError> {
    rows.into_iter()
        .map(|row| {
            let review_status = match row.review_status.as_str() {
                "active" => ProblemReviewStatus::Active,
                "completed" => ProblemReviewStatus::Completed,
                "paused" => ProblemReviewStatus::Paused,
                "excluded" => ProblemReviewStatus::Excluded,
                value => {
                    return Err(CustomMetricServiceError::InvalidReviewStatus(value.into()));
                }
            };
            Ok(Problem {
                id: row.id,
                review_status,
            })
        })
        .collect()
}

fn adapt_attempts(
    rows: Vec<ProblemAttemptRow>,
) -> Result<Vec<ProblemAttempt>, CustomMetricServiceError> {
    rows.into_iter().map(adapt_attempt).collect()
}

fn adapt_attempt(row: ProblemAttemptRow) -> Result<ProblemAttempt, CustomMetricServiceError> {
    let confidence = match row.confidence.as_deref() {
        Some("high") => Some(AttemptConfidence::High),
        Some("medium") => Some(AttemptConfidence::Medium),
        Some("low") => Some(AttemptConfidence::Low),
        None => None,
        Some(value) => return Err(CustomMetricServiceError::InvalidConfidence(value.into())),
    };
    Ok(ProblemAttempt {
        id: row.id,
        problem_id: row.problem_id,
        round_id: row.round_id,
        round_number: row
            .round_number
            .map(|value| {
                u32::try_from(value).map_err(|_| {
                    CustomMetricServiceError::NumericRange(format!("round_number={value}"))
                })
            })
            .transpose()?,
        answered_at: row.answered_at,
        attempt_number: u32::try_from(row.attempt_number).map_err(|_| {
            CustomMetricServiceError::NumericRange(format!("attempt_number={}", row.attempt_number))
        })?,
        earned_score: row.earned_score_milli as f64 / 1000.0,
        max_score: row.max_score_milli as f64 / 1000.0,
        confidence,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        custom_metric_repository::{
            load_metric_attempts, load_metric_problems, load_metric_records,
        },
        custom_metrics::{
            default_metric_templates, default_population_definition, save_custom_metric,
            seed_default_metrics, soft_delete_custom_metric, CustomMetric, CustomMetricRecord,
            MetricOrigin, CUSTOM_METRIC_DEFINITION_VERSION,
        },
    };
    use rusqlite::{params, Connection};

    fn fixture_database() -> Connection {
        let connection = Connection::open_in_memory().unwrap();
        connection
            .execute_batch("PRAGMA foreign_keys = ON;")
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
            .execute_batch(include_str!("../migrations/005_custom_metrics.sql"))
            .unwrap();
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
                 ) VALUES
                   ('p1','section-1','1',0,1000,'active'),
                   ('p2','section-1','2',1,1000,'completed'),
                   ('p3','section-1','3',2,1000,'excluded');
                 INSERT INTO practice_rounds(
                   id,question_bank_id,round_number,started_at
                 ) VALUES
                   ('round-1','bank-1',1,'2026-01-01'),
                   ('round-2','bank-1',2,'2026-01-02'),
                   ('round-3','bank-1',3,'2026-01-03');
                 INSERT INTO problem_attempts(
                   id,problem_id,round_id,answered_at,attempt_number,
                   earned_score_milli,max_score_milli,confidence
                 ) VALUES
                   ('p1-a1','p1','round-1',NULL,1,1000,1000,'high'),
                   ('p2-a1','p2','round-1','2026-01-01T00:00:00Z',1,0,1000,'low'),
                   ('p2-a2','p2','round-2','2026-01-02T00:00:00Z',2,1000,1000,NULL),
                   ('p2-a3','p2','round-3','2026-01-03T00:00:00Z',3,1000,1000,'medium'),
                   ('p3-a1','p3','round-1','2026-01-01T00:00:00Z',1,1000,1000,'high');",
            )
            .unwrap();
        connection
    }

    fn add_default_metrics(connection: &mut Connection) {
        let transaction = connection.transaction().unwrap();
        seed_default_metrics(&transaction, "bank-1").unwrap();
        transaction.commit().unwrap();
    }

    fn add_hidden_custom_metric(connection: &Connection) {
        let template = &default_metric_templates()[0];
        let metric = CustomMetric {
            id: "custom-correct".into(),
            question_bank_id: "bank-1".into(),
            name: "カスタム正解歴".into(),
            icon: Some("C".into()),
            definition_version: CUSTOM_METRIC_DEFINITION_VERSION,
            definition: template.definition.clone(),
            population: default_population_definition(),
            is_visible: false,
            sort_order: 10,
            origin: MetricOrigin::Custom,
            system_key: None,
        };
        let record = CustomMetricRecord::from_metric(
            &metric,
            "2026-01-01T00:00:00Z".into(),
            "2026-01-01T00:00:00Z".into(),
            None,
        )
        .unwrap();
        save_custom_metric(connection, &record).unwrap();
    }

    #[test]
    fn repository_loads_problems_attempts_and_active_metrics() {
        let mut connection = fixture_database();
        add_default_metrics(&mut connection);
        add_hidden_custom_metric(&connection);
        let deleted_id = load_metric_records(&connection, "bank-1")
            .unwrap()
            .into_iter()
            .find(|record| record.system_key.as_deref() == Some("multiple_correct"))
            .unwrap()
            .id;
        soft_delete_custom_metric(&connection, &deleted_id, "2026-02-01T00:00:00Z").unwrap();

        let problems = load_metric_problems(&connection, "bank-1").unwrap();
        let attempts = load_metric_attempts(&connection, "bank-1").unwrap();
        let metrics = load_metric_records(&connection, "bank-1").unwrap();
        assert_eq!(problems.len(), 3);
        assert_eq!(attempts.len(), 5);
        assert_eq!(
            attempts
                .iter()
                .find(|attempt| attempt.id == "p2-a2")
                .unwrap()
                .round_number,
            Some(2)
        );
        assert_eq!(metrics.len(), 3);
        assert!(metrics.iter().any(|metric| !metric.is_visible));
        assert!(!metrics.iter().any(|metric| metric.id == deleted_id));
    }

    #[test]
    fn adapter_converts_status_confidence_round_and_null_values() {
        let problems = adapt_problems(vec![
            ProblemRow {
                id: "active".into(),
                review_status: "active".into(),
            },
            ProblemRow {
                id: "excluded".into(),
                review_status: "excluded".into(),
            },
        ])
        .unwrap();
        assert_eq!(problems[0].review_status, ProblemReviewStatus::Active);
        assert_eq!(problems[1].review_status, ProblemReviewStatus::Excluded);

        let attempts = adapt_attempts(vec![ProblemAttemptRow {
            id: "a1".into(),
            problem_id: "active".into(),
            round_id: "round-2".into(),
            round_number: Some(2),
            answered_at: None,
            attempt_number: 3,
            earned_score_milli: 500,
            max_score_milli: 1000,
            confidence: None,
        }])
        .unwrap();
        assert_eq!(attempts[0].round_number, Some(2));
        assert_eq!(attempts[0].answered_at, None);
        assert_eq!(attempts[0].confidence, None);
        assert_eq!(attempts[0].earned_score, 0.5);
        assert_eq!(attempts[0].max_score, 1.0);
    }

    #[test]
    fn service_evaluates_whole_bank_and_returns_dto_sets() {
        let mut connection = fixture_database();
        add_default_metrics(&mut connection);
        add_hidden_custom_metric(&connection);
        let deleted_id = load_metric_records(&connection, "bank-1")
            .unwrap()
            .into_iter()
            .find(|record| record.system_key.as_deref() == Some("multiple_correct"))
            .unwrap()
            .id;
        soft_delete_custom_metric(&connection, &deleted_id, "2026-02-01T00:00:00Z").unwrap();

        let summaries = summarize_custom_metrics(&connection, "bank-1").unwrap();
        assert_eq!(summaries.len(), 3);
        let correct = summaries
            .iter()
            .find(|summary| summary.metric_name == "正解歴")
            .unwrap();
        assert_eq!(correct.icon.as_deref(), Some("○"));
        assert_eq!(
            correct.population_problem_ids,
            HashSet::from(["p1".into(), "p2".into()])
        );
        assert_eq!(
            correct.matched_problem_ids,
            HashSet::from(["p1".into(), "p2".into()])
        );

        let confident = summaries
            .iter()
            .find(|summary| summary.metric_name == "自信あり正解歴")
            .unwrap();
        assert_eq!(confident.matched_problem_ids, HashSet::from(["p1".into()]));

        let custom = summaries
            .iter()
            .find(|summary| summary.metric_id == "custom-correct")
            .unwrap();
        assert_eq!(custom.metric_name, "カスタム正解歴");
        assert_eq!(custom.icon.as_deref(), Some("C"));
        assert_eq!(custom.matched_problem_ids, correct.matched_problem_ids);
        assert!(!summaries
            .iter()
            .any(|summary| summary.metric_id == deleted_id));
    }

    #[test]
    fn evaluates_one_thousand_problems_and_ten_thousand_attempts() {
        let mut connection = Connection::open_in_memory().unwrap();
        connection
            .execute_batch("PRAGMA foreign_keys = ON;")
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
            .execute_batch(include_str!("../migrations/005_custom_metrics.sql"))
            .unwrap();

        let transaction = connection.transaction().unwrap();
        transaction
            .execute_batch(
                "INSERT INTO materials(id,title,created_at,updated_at)
                   VALUES ('material-1','大規模教材','2026-01-01','2026-01-01');
                 INSERT INTO question_banks(id,material_id,title,created_at,updated_at)
                   VALUES ('bank-1','material-1','大規模教材','2026-01-01','2026-01-01');
                 INSERT INTO question_sections(
                   id,question_bank_id,title,sort_order,evaluation_type,is_mock_exam_section
                 ) VALUES ('section-1','bank-1','問題',0,'binary',0);
                 INSERT INTO practice_rounds(id,question_bank_id,round_number,started_at)
                   VALUES ('round-1','bank-1',1,'2026-01-01');",
            )
            .unwrap();
        {
            let mut insert_problem = transaction
                .prepare(
                    "INSERT INTO problems(
                       id,section_id,number,sort_order,default_max_score_milli,review_status
                     ) VALUES (?1,'section-1',?2,?3,1000,'active')",
                )
                .unwrap();
            let mut insert_attempt = transaction
                .prepare(
                    "INSERT INTO problem_attempts(
                       id,problem_id,round_id,answered_at,attempt_number,
                       earned_score_milli,max_score_milli,confidence
                     ) VALUES (?1,?2,'round-1',NULL,?3,1000,1000,'high')",
                )
                .unwrap();
            for problem_number in 0..1_000 {
                let problem_id = format!("p-{problem_number}");
                insert_problem
                    .execute(params![
                        problem_id,
                        problem_number.to_string(),
                        problem_number
                    ])
                    .unwrap();
                for attempt_number in 1..=10 {
                    insert_attempt
                        .execute(params![
                            format!("a-{problem_number}-{attempt_number}"),
                            problem_id,
                            attempt_number
                        ])
                        .unwrap();
                }
            }
        }
        seed_default_metrics(&transaction, "bank-1").unwrap();
        transaction.commit().unwrap();

        let summaries = summarize_custom_metrics(&connection, "bank-1").unwrap();
        assert_eq!(summaries.len(), 3);
        assert!(summaries.iter().all(|summary| {
            summary.population_problem_ids.len() == 1_000
                && summary.matched_problem_ids.len() == 1_000
        }));
    }
}
