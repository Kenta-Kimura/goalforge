use crate::{
    custom_metric_management_service::{
        create_custom_metric, delete_custom_metric, list_custom_metrics, move_custom_metric,
        reset_custom_metrics, restore_default_custom_metric as restore_managed_default_metric,
        set_custom_metric_visibility, update_custom_metric, CustomMetricManagementError,
        CustomMetricWriteInput,
    },
    custom_metric_service::{
        summarize_custom_metrics, CustomMetricServiceError, CustomMetricSummary,
    },
    custom_metrics::{
        CustomMetric, MetricDefinition, MetricOrigin, PopulationDefinition,
        RestoreDefaultMetricOutcome,
    },
};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use thiserror::Error;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomMetricSummaryDto {
    pub metric_id: String,
    pub metric_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
    pub matched_problem_ids: Vec<String>,
    pub population_problem_ids: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomMetricDefinitionDto {
    pub metric_id: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
    pub definition: MetricDefinition,
    pub population: PopulationDefinition,
    pub is_visible: bool,
    pub sort_order: i32,
    pub origin: MetricOrigin,
    pub system_key: Option<String>,
}

impl From<CustomMetric> for CustomMetricDefinitionDto {
    fn from(metric: CustomMetric) -> Self {
        Self {
            metric_id: metric.id,
            name: metric.name,
            icon: metric.icon,
            definition: metric.definition,
            population: metric.population,
            is_visible: metric.is_visible,
            sort_order: metric.sort_order,
            origin: metric.origin,
            system_key: metric.system_key,
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CustomMetricWriteDto {
    pub name: String,
    pub icon: Option<String>,
    pub definition: MetricDefinition,
    pub population: PopulationDefinition,
    pub is_visible: bool,
}

impl From<CustomMetricWriteDto> for CustomMetricWriteInput {
    fn from(input: CustomMetricWriteDto) -> Self {
        Self {
            name: input.name,
            icon: input.icon,
            definition: input.definition,
            population: input.population,
            is_visible: input.is_visible,
        }
    }
}

impl From<CustomMetricSummary> for CustomMetricSummaryDto {
    fn from(summary: CustomMetricSummary) -> Self {
        let mut matched_problem_ids = summary.matched_problem_ids.into_iter().collect::<Vec<_>>();
        matched_problem_ids.sort();
        let mut population_problem_ids = summary
            .population_problem_ids
            .into_iter()
            .collect::<Vec<_>>();
        population_problem_ids.sort();
        Self {
            metric_id: summary.metric_id,
            metric_name: summary.metric_name,
            icon: summary.icon,
            matched_problem_ids,
            population_problem_ids,
        }
    }
}

#[derive(Debug, Error)]
pub enum CustomMetricApiError {
    #[error("{0}")]
    Service(#[from] CustomMetricServiceError),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomMetricManagementErrorDto {
    pub kind: CustomMetricManagementErrorKind,
    pub message: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CustomMetricManagementErrorKind {
    Validation,
    Repository,
    Service,
}

impl From<CustomMetricManagementError> for CustomMetricManagementErrorDto {
    fn from(error: CustomMetricManagementError) -> Self {
        let kind = match &error {
            CustomMetricManagementError::Validation(_) => {
                CustomMetricManagementErrorKind::Validation
            }
            CustomMetricManagementError::Repository(_) => {
                CustomMetricManagementErrorKind::Repository
            }
            CustomMetricManagementError::NotFound(_) => CustomMetricManagementErrorKind::Service,
        };
        Self {
            kind,
            message: error.to_string(),
        }
    }
}

impl CustomMetricManagementErrorDto {
    pub fn repository(message: impl Into<String>) -> Self {
        Self {
            kind: CustomMetricManagementErrorKind::Repository,
            message: message.into(),
        }
    }
}

pub fn get_custom_metric_summaries_from_connection(
    connection: &Connection,
    question_bank_id: &str,
) -> Result<Vec<CustomMetricSummaryDto>, CustomMetricApiError> {
    summarize_custom_metrics(connection, question_bank_id)
        .map(|summaries| {
            summaries
                .into_iter()
                .map(CustomMetricSummaryDto::from)
                .collect()
        })
        .map_err(CustomMetricApiError::from)
}

pub fn restore_default_custom_metric_with_connection(
    connection: &mut Connection,
    question_bank_id: &str,
    system_key: &str,
) -> Result<RestoreDefaultMetricOutcome, CustomMetricManagementErrorDto> {
    restore_managed_default_metric(connection, question_bank_id, system_key)
        .map_err(CustomMetricManagementErrorDto::from)
}

pub fn list_custom_metrics_from_connection(
    connection: &Connection,
    question_bank_id: &str,
) -> Result<Vec<CustomMetricDefinitionDto>, CustomMetricManagementErrorDto> {
    list_custom_metrics(connection, question_bank_id)
        .map(|metrics| {
            metrics
                .into_iter()
                .map(CustomMetricDefinitionDto::from)
                .collect()
        })
        .map_err(CustomMetricManagementErrorDto::from)
}

pub fn create_custom_metric_with_connection(
    connection: &mut Connection,
    question_bank_id: &str,
    input: CustomMetricWriteDto,
) -> Result<CustomMetricDefinitionDto, CustomMetricManagementErrorDto> {
    create_custom_metric(connection, question_bank_id, input.into())
        .map(CustomMetricDefinitionDto::from)
        .map_err(CustomMetricManagementErrorDto::from)
}

pub fn update_custom_metric_with_connection(
    connection: &mut Connection,
    metric_id: &str,
    input: CustomMetricWriteDto,
) -> Result<CustomMetricDefinitionDto, CustomMetricManagementErrorDto> {
    update_custom_metric(connection, metric_id, input.into())
        .map(CustomMetricDefinitionDto::from)
        .map_err(CustomMetricManagementErrorDto::from)
}

pub fn set_custom_metric_visibility_with_connection(
    connection: &mut Connection,
    metric_id: &str,
    is_visible: bool,
) -> Result<CustomMetricDefinitionDto, CustomMetricManagementErrorDto> {
    set_custom_metric_visibility(connection, metric_id, is_visible)
        .map(CustomMetricDefinitionDto::from)
        .map_err(CustomMetricManagementErrorDto::from)
}

pub fn move_custom_metric_with_connection(
    connection: &mut Connection,
    metric_id: &str,
    new_sort_order: i32,
) -> Result<Vec<CustomMetricDefinitionDto>, CustomMetricManagementErrorDto> {
    move_custom_metric(connection, metric_id, new_sort_order)
        .map(|metrics| {
            metrics
                .into_iter()
                .map(CustomMetricDefinitionDto::from)
                .collect()
        })
        .map_err(CustomMetricManagementErrorDto::from)
}

pub fn delete_custom_metric_with_connection(
    connection: &mut Connection,
    metric_id: &str,
) -> Result<(), CustomMetricManagementErrorDto> {
    delete_custom_metric(connection, metric_id).map_err(CustomMetricManagementErrorDto::from)
}

pub fn reset_custom_metrics_with_connection(
    connection: &mut Connection,
    question_bank_id: &str,
) -> Result<Vec<CustomMetricDefinitionDto>, CustomMetricManagementErrorDto> {
    reset_custom_metrics(connection, question_bank_id)
        .map(|metrics| {
            metrics
                .into_iter()
                .map(CustomMetricDefinitionDto::from)
                .collect()
        })
        .map_err(CustomMetricManagementErrorDto::from)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::custom_metrics::{
        default_metric_templates, default_population_definition, load_custom_metrics,
        seed_default_metrics, soft_delete_custom_metric,
    };
    use rusqlite::Connection;
    use std::collections::HashSet;

    fn database() -> Connection {
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
    }

    fn insert_bank(connection: &Connection, bank_id: &str, material_id: &str) {
        connection
            .execute(
                "INSERT INTO materials(id,title,created_at,updated_at)
                 VALUES (?1,'教材','2026-01-01','2026-01-01')",
                [material_id],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO question_banks(id,material_id,title,created_at,updated_at)
                 VALUES (?1,?2,'教材','2026-01-01','2026-01-01')",
                [bank_id, material_id],
            )
            .unwrap();
    }

    fn write_dto(name: &str) -> CustomMetricWriteDto {
        CustomMetricWriteDto {
            name: name.into(),
            icon: Some("◇".into()),
            definition: default_metric_templates()[0].definition.clone(),
            population: default_population_definition(),
            is_visible: true,
        }
    }

    #[test]
    fn dto_converts_sets_to_sorted_arrays_without_derived_counts() {
        let dto = CustomMetricSummaryDto::from(CustomMetricSummary {
            metric_id: "metric-1".into(),
            metric_name: "正解歴".into(),
            icon: None,
            matched_problem_ids: HashSet::from(["p2".into(), "p1".into()]),
            population_problem_ids: HashSet::from(["p3".into(), "p1".into(), "p2".into()]),
        });
        assert_eq!(dto.matched_problem_ids, vec!["p1", "p2"]);
        assert_eq!(dto.population_problem_ids, vec!["p1", "p2", "p3"]);
        let json = serde_json::to_value(dto).unwrap();
        assert_eq!(json["metricId"], "metric-1");
        assert!(json.get("icon").is_none());
        assert!(json.get("matchedCount").is_none());
        assert!(json.get("populationCount").is_none());
        assert!(json.get("percentage").is_none());
    }

    #[test]
    fn api_gets_whole_bank_empty_bank_and_bank_without_metrics() {
        let mut connection = database();
        insert_bank(&connection, "bank-full", "material-full");
        connection
            .execute_batch(
                "INSERT INTO question_sections(
                   id,question_bank_id,title,sort_order,evaluation_type,is_mock_exam_section
                 ) VALUES ('section-full','bank-full','問題',0,'binary',0);
                 INSERT INTO problems(
                   id,section_id,number,sort_order,default_max_score_milli,review_status
                 ) VALUES ('problem-full','section-full','1',0,1000,'active');
                 INSERT INTO practice_rounds(id,question_bank_id,round_number,started_at)
                   VALUES ('round-full','bank-full',1,'2026-01-01');
                 INSERT INTO problem_attempts(
                   id,problem_id,round_id,answered_at,attempt_number,
                   earned_score_milli,max_score_milli,confidence
                 ) VALUES (
                   'attempt-full','problem-full','round-full',NULL,1,1000,1000,'high'
                 );",
            )
            .unwrap();
        let transaction = connection.transaction().unwrap();
        seed_default_metrics(&transaction, "bank-full").unwrap();
        transaction.commit().unwrap();

        insert_bank(&connection, "bank-empty", "material-empty");
        let transaction = connection.transaction().unwrap();
        seed_default_metrics(&transaction, "bank-empty").unwrap();
        transaction.commit().unwrap();

        insert_bank(&connection, "bank-no-metrics", "material-no-metrics");

        let full = get_custom_metric_summaries_from_connection(&connection, "bank-full").unwrap();
        assert_eq!(full.len(), 3);
        assert!(full
            .iter()
            .all(|summary| summary.population_problem_ids == vec!["problem-full"]));
        assert_eq!(
            full.iter()
                .find(|summary| summary.metric_name == "正解歴")
                .unwrap()
                .matched_problem_ids,
            vec!["problem-full"]
        );
        assert!(full
            .iter()
            .find(|summary| summary.metric_name == "複数正解歴")
            .unwrap()
            .matched_problem_ids
            .is_empty());

        let empty = get_custom_metric_summaries_from_connection(&connection, "bank-empty").unwrap();
        assert_eq!(empty.len(), 3);
        assert!(empty.iter().all(|summary| {
            summary.matched_problem_ids.is_empty() && summary.population_problem_ids.is_empty()
        }));

        assert!(
            get_custom_metric_summaries_from_connection(&connection, "bank-no-metrics")
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn restore_api_connects_to_existing_restore_transaction() {
        let mut connection = database();
        insert_bank(&connection, "bank-restore", "material-restore");
        let transaction = connection.transaction().unwrap();
        seed_default_metrics(&transaction, "bank-restore").unwrap();
        transaction.commit().unwrap();
        let record = load_custom_metrics(&connection, "bank-restore", false)
            .unwrap()
            .into_iter()
            .find(|record| record.system_key.as_deref() == Some("ever_correct"))
            .unwrap();
        soft_delete_custom_metric(&connection, &record.id, "2026-02-01T00:00:00Z").unwrap();

        assert_eq!(
            restore_default_custom_metric_with_connection(
                &mut connection,
                "bank-restore",
                "ever_correct"
            )
            .unwrap(),
            RestoreDefaultMetricOutcome::Restored
        );
        let restored = load_custom_metrics(&connection, "bank-restore", false).unwrap();
        assert!(restored.iter().any(|item| item.id == record.id));
    }

    #[test]
    fn management_api_exposes_ast_dto_and_connects_crud_commands() {
        let mut connection = database();
        insert_bank(&connection, "bank-manage", "material-manage");
        let transaction = connection.transaction().unwrap();
        seed_default_metrics(&transaction, "bank-manage").unwrap();
        transaction.commit().unwrap();

        let created =
            create_custom_metric_with_connection(&mut connection, "bank-manage", write_dto("追加"))
                .unwrap();
        assert_eq!(created.origin, MetricOrigin::Custom);
        assert_eq!(created.system_key, None);
        let json = serde_json::to_value(&created).unwrap();
        assert!(json["definition"].is_object());
        assert!(json["population"].is_object());
        assert!(json.get("definitionJson").is_none());

        let updated = update_custom_metric_with_connection(
            &mut connection,
            &created.metric_id,
            write_dto("更新"),
        )
        .unwrap();
        assert_eq!(updated.name, "更新");

        let hidden = set_custom_metric_visibility_with_connection(
            &mut connection,
            &created.metric_id,
            false,
        )
        .unwrap();
        assert!(!hidden.is_visible);

        let moved =
            move_custom_metric_with_connection(&mut connection, &created.metric_id, 0).unwrap();
        assert_eq!(moved[0].metric_id, created.metric_id);
        assert_eq!(
            moved
                .iter()
                .map(|metric| metric.sort_order)
                .collect::<Vec<_>>(),
            vec![0, 1, 2, 3]
        );

        delete_custom_metric_with_connection(&mut connection, &created.metric_id).unwrap();
        assert!(
            list_custom_metrics_from_connection(&connection, "bank-manage")
                .unwrap()
                .iter()
                .all(|metric| metric.metric_id != created.metric_id)
        );
    }

    #[test]
    fn management_api_distinguishes_validation_repository_and_service_errors() {
        let mut connection = database();
        insert_bank(&connection, "bank-errors", "material-errors");

        let validation =
            create_custom_metric_with_connection(&mut connection, "bank-errors", write_dto(" "))
                .unwrap_err();
        assert_eq!(validation.kind, CustomMetricManagementErrorKind::Validation);

        let service =
            set_custom_metric_visibility_with_connection(&mut connection, "missing", false)
                .unwrap_err();
        assert_eq!(service.kind, CustomMetricManagementErrorKind::Service);

        let repository = create_custom_metric_with_connection(
            &mut connection,
            "missing-bank",
            write_dto("追加"),
        )
        .unwrap_err();
        assert_eq!(repository.kind, CustomMetricManagementErrorKind::Repository);
    }

    #[test]
    fn reset_api_returns_factory_default_dtos() {
        let mut connection = database();
        insert_bank(&connection, "bank-reset", "material-reset");
        let transaction = connection.transaction().unwrap();
        seed_default_metrics(&transaction, "bank-reset").unwrap();
        transaction.commit().unwrap();
        let custom = create_custom_metric_with_connection(
            &mut connection,
            "bank-reset",
            write_dto("Custom"),
        )
        .unwrap();

        let reset = reset_custom_metrics_with_connection(&mut connection, "bank-reset").unwrap();

        assert_eq!(reset.len(), 3);
        assert!(reset
            .iter()
            .all(|metric| metric.origin == MetricOrigin::Default));
        assert!(reset
            .iter()
            .all(|metric| metric.metric_id != custom.metric_id));
        assert_eq!(
            reset
                .iter()
                .map(|metric| metric.sort_order)
                .collect::<Vec<_>>(),
            vec![0, 1, 2]
        );
    }
}
