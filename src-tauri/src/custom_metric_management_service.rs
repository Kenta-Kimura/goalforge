use crate::{
    custom_metric_repository::{
        find_custom_metric_record, list_custom_metric_records, logically_delete_custom_metric,
        persist_custom_metric_record, update_custom_metric_sort_orders,
        update_custom_metric_visibility,
    },
    custom_metrics::{
        default_metric_templates, reset_default_metric, restore_default_metric,
        validate_definition, validate_population, CustomMetric, CustomMetricRecord,
        MetricDefinition, MetricOrigin, PopulationDefinition, RestoreDefaultMetricOutcome,
    },
};
use chrono::{SecondsFormat, Utc};
use rusqlite::Connection;
use thiserror::Error;
use uuid::Uuid;

#[derive(Debug, Clone)]
pub struct CustomMetricWriteInput {
    pub name: String,
    pub icon: Option<String>,
    pub definition: MetricDefinition,
    pub population: PopulationDefinition,
    pub is_visible: bool,
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum CustomMetricManagementError {
    #[error("入力内容が不正です: {0}")]
    Validation(String),
    #[error("カスタムメトリクスが見つかりません: {0}")]
    NotFound(String),
    #[error("カスタムメトリクスの保存処理に失敗しました: {0}")]
    Repository(String),
}

pub fn list_custom_metrics(
    connection: &Connection,
    question_bank_id: &str,
) -> Result<Vec<CustomMetric>, CustomMetricManagementError> {
    list_custom_metric_records(connection, question_bank_id)
        .map_err(CustomMetricManagementError::Repository)?
        .into_iter()
        .map(|record| {
            record
                .to_metric()
                .map_err(CustomMetricManagementError::Repository)
        })
        .collect()
}

pub fn create_custom_metric(
    connection: &mut Connection,
    question_bank_id: &str,
    input: CustomMetricWriteInput,
) -> Result<CustomMetric, CustomMetricManagementError> {
    let input = validate_write_input(input)?;
    let transaction = connection.transaction().map_err(repository_error)?;
    let records =
        list_custom_metric_records(&transaction, question_bank_id).map_err(repository_error)?;
    let timestamp = management_now();
    let metric = CustomMetric {
        id: Uuid::new_v4().to_string(),
        question_bank_id: question_bank_id.into(),
        name: input.name,
        icon: input.icon,
        definition_version: input.definition.version,
        definition: input.definition,
        population: input.population,
        is_visible: input.is_visible,
        sort_order: records.len() as i32,
        origin: MetricOrigin::Custom,
        system_key: None,
    };
    let record =
        CustomMetricRecord::from_metric(&metric, timestamp.clone(), timestamp.clone(), None)
            .map_err(CustomMetricManagementError::Validation)?;
    persist_custom_metric_record(&transaction, &record).map_err(repository_error)?;
    let mut ordered_ids = records
        .into_iter()
        .map(|record| record.id)
        .collect::<Vec<_>>();
    ordered_ids.push(metric.id.clone());
    update_custom_metric_sort_orders(&transaction, &ordered_ids, &timestamp)
        .map_err(repository_error)?;
    transaction.commit().map_err(repository_error)?;
    Ok(metric)
}

pub fn update_custom_metric(
    connection: &mut Connection,
    metric_id: &str,
    input: CustomMetricWriteInput,
) -> Result<CustomMetric, CustomMetricManagementError> {
    let input = validate_write_input(input)?;
    let transaction = connection.transaction().map_err(repository_error)?;
    let existing = find_custom_metric_record(&transaction, metric_id, false)
        .map_err(repository_error)?
        .ok_or_else(|| CustomMetricManagementError::NotFound(metric_id.into()))?;
    let mut metric = existing
        .to_metric()
        .map_err(CustomMetricManagementError::Repository)?;
    metric.name = input.name;
    metric.icon = input.icon;
    metric.definition_version = input.definition.version;
    metric.definition = input.definition;
    metric.population = input.population;
    metric.is_visible = input.is_visible;
    let updated = CustomMetricRecord::from_metric(
        &metric,
        existing.created_at,
        management_now(),
        existing.deleted_at,
    )
    .map_err(CustomMetricManagementError::Validation)?;
    persist_custom_metric_record(&transaction, &updated).map_err(repository_error)?;
    transaction.commit().map_err(repository_error)?;
    Ok(metric)
}

pub fn set_custom_metric_visibility(
    connection: &mut Connection,
    metric_id: &str,
    is_visible: bool,
) -> Result<CustomMetric, CustomMetricManagementError> {
    let transaction = connection.transaction().map_err(repository_error)?;
    let existing = find_custom_metric_record(&transaction, metric_id, false)
        .map_err(repository_error)?
        .ok_or_else(|| CustomMetricManagementError::NotFound(metric_id.into()))?;
    if !update_custom_metric_visibility(&transaction, metric_id, is_visible, &management_now())
        .map_err(repository_error)?
    {
        return Err(CustomMetricManagementError::NotFound(metric_id.into()));
    }
    transaction.commit().map_err(repository_error)?;
    let mut metric = existing
        .to_metric()
        .map_err(CustomMetricManagementError::Repository)?;
    metric.is_visible = is_visible;
    Ok(metric)
}

pub fn move_custom_metric(
    connection: &mut Connection,
    metric_id: &str,
    new_sort_order: i32,
) -> Result<Vec<CustomMetric>, CustomMetricManagementError> {
    let transaction = connection.transaction().map_err(repository_error)?;
    let target = find_custom_metric_record(&transaction, metric_id, false)
        .map_err(repository_error)?
        .ok_or_else(|| CustomMetricManagementError::NotFound(metric_id.into()))?;
    let records = list_custom_metric_records(&transaction, &target.question_bank_id)
        .map_err(repository_error)?;
    let new_index = usize::try_from(new_sort_order).map_err(|_| {
        CustomMetricManagementError::Validation("並び順は0以上で指定してください。".into())
    })?;
    if new_index >= records.len() {
        return Err(CustomMetricManagementError::Validation(format!(
            "並び順は0から{}の範囲で指定してください。",
            records.len().saturating_sub(1)
        )));
    }
    let current_index = records
        .iter()
        .position(|record| record.id == metric_id)
        .ok_or_else(|| CustomMetricManagementError::NotFound(metric_id.into()))?;
    let mut ordered_ids = records
        .iter()
        .map(|record| record.id.clone())
        .collect::<Vec<_>>();
    let moved = ordered_ids.remove(current_index);
    ordered_ids.insert(new_index, moved);
    update_custom_metric_sort_orders(&transaction, &ordered_ids, &management_now())
        .map_err(repository_error)?;
    transaction.commit().map_err(repository_error)?;
    list_custom_metrics(connection, &target.question_bank_id)
}

pub fn delete_custom_metric(
    connection: &mut Connection,
    metric_id: &str,
) -> Result<(), CustomMetricManagementError> {
    let transaction = connection.transaction().map_err(repository_error)?;
    let target = find_custom_metric_record(&transaction, metric_id, false)
        .map_err(repository_error)?
        .ok_or_else(|| CustomMetricManagementError::NotFound(metric_id.into()))?;
    let timestamp = management_now();
    if !logically_delete_custom_metric(&transaction, metric_id, &timestamp)
        .map_err(repository_error)?
    {
        return Err(CustomMetricManagementError::NotFound(metric_id.into()));
    }
    let remaining = list_custom_metric_records(&transaction, &target.question_bank_id)
        .map_err(repository_error)?;
    let ordered_ids = remaining
        .into_iter()
        .map(|record| record.id)
        .collect::<Vec<_>>();
    update_custom_metric_sort_orders(&transaction, &ordered_ids, &timestamp)
        .map_err(repository_error)?;
    transaction.commit().map_err(repository_error)?;
    Ok(())
}

pub fn restore_default_custom_metric(
    connection: &mut Connection,
    question_bank_id: &str,
    system_key: &str,
) -> Result<RestoreDefaultMetricOutcome, CustomMetricManagementError> {
    let transaction = connection.transaction().map_err(repository_error)?;
    let outcome = restore_default_metric(&transaction, question_bank_id, system_key)
        .map_err(CustomMetricManagementError::Repository)?;
    let records =
        list_custom_metric_records(&transaction, question_bank_id).map_err(repository_error)?;
    let ordered_ids = records
        .into_iter()
        .map(|record| record.id)
        .collect::<Vec<_>>();
    update_custom_metric_sort_orders(&transaction, &ordered_ids, &management_now())
        .map_err(repository_error)?;
    transaction.commit().map_err(repository_error)?;
    Ok(outcome)
}

pub fn reset_custom_metrics(
    connection: &mut Connection,
    question_bank_id: &str,
) -> Result<Vec<CustomMetric>, CustomMetricManagementError> {
    let transaction = connection.transaction().map_err(repository_error)?;
    let timestamp = management_now();
    let records =
        list_custom_metric_records(&transaction, question_bank_id).map_err(repository_error)?;
    for record in records
        .iter()
        .filter(|record| record.origin == MetricOrigin::Custom)
    {
        if !logically_delete_custom_metric(&transaction, &record.id, &timestamp)
            .map_err(repository_error)?
        {
            return Err(CustomMetricManagementError::NotFound(record.id.clone()));
        }
    }
    for template in default_metric_templates() {
        reset_default_metric(&transaction, question_bank_id, template.system_key)
            .map_err(repository_error)?;
    }
    let defaults =
        list_custom_metric_records(&transaction, question_bank_id).map_err(repository_error)?;
    let ordered_ids = defaults
        .iter()
        .map(|record| record.id.clone())
        .collect::<Vec<_>>();
    update_custom_metric_sort_orders(&transaction, &ordered_ids, &timestamp)
        .map_err(repository_error)?;
    let metrics = defaults
        .into_iter()
        .map(|record| record.to_metric().map_err(repository_error))
        .collect::<Result<Vec<_>, _>>()?;
    transaction.commit().map_err(repository_error)?;
    Ok(metrics)
}

fn validate_write_input(
    mut input: CustomMetricWriteInput,
) -> Result<CustomMetricWriteInput, CustomMetricManagementError> {
    input.name = input.name.trim().into();
    if input.name.is_empty() {
        return Err(CustomMetricManagementError::Validation(
            "メトリクス名を入力してください。".into(),
        ));
    }
    input.icon = input
        .icon
        .map(|icon| icon.trim().to_string())
        .filter(|icon| !icon.is_empty());
    validate_definition(&input.definition)
        .map_err(|error| CustomMetricManagementError::Validation(error.to_string()))?;
    validate_population(&input.population)
        .map_err(|error| CustomMetricManagementError::Validation(error.to_string()))?;
    Ok(input)
}

fn repository_error(error: impl ToString) -> CustomMetricManagementError {
    CustomMetricManagementError::Repository(error.to_string())
}

fn management_now() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        custom_metric_repository::{
            find_custom_metric_record, list_custom_metric_records, update_custom_metric_visibility,
        },
        custom_metrics::{
            default_metric_templates, default_population_definition, seed_default_metrics,
        },
    };

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

    fn insert_bank(connection: &Connection) {
        connection
            .execute_batch(
                "INSERT INTO materials(id,title,created_at,updated_at)
                 VALUES ('material-1','教材','2026-01-01','2026-01-01');
                 INSERT INTO question_banks(id,material_id,title,created_at,updated_at)
                 VALUES ('bank-1','material-1','問題集','2026-01-01','2026-01-01');",
            )
            .unwrap();
    }

    fn valid_input(name: &str) -> CustomMetricWriteInput {
        CustomMetricWriteInput {
            name: name.into(),
            icon: Some("◇".into()),
            definition: default_metric_templates()[0].definition.clone(),
            population: default_population_definition(),
            is_visible: true,
        }
    }

    fn seeded_database() -> Connection {
        let mut connection = database();
        insert_bank(&connection);
        let transaction = connection.transaction().unwrap();
        seed_default_metrics(&transaction, "bank-1").unwrap();
        transaction.commit().unwrap();
        connection
    }

    #[test]
    fn repository_lists_persists_updates_visibility_and_excludes_deleted_records() {
        let mut connection = seeded_database();
        let initial = list_custom_metric_records(&connection, "bank-1").unwrap();
        assert_eq!(initial.len(), 3);

        let created = create_custom_metric(&mut connection, "bank-1", valid_input("追加")).unwrap();
        let found = find_custom_metric_record(&connection, &created.id, false)
            .unwrap()
            .unwrap();
        assert_eq!(found.name, "追加");

        let definition_json = found.definition_json.clone();
        update_custom_metric_visibility(&connection, &created.id, false, "2026-02-01T00:00:00Z")
            .unwrap();
        let hidden = find_custom_metric_record(&connection, &created.id, false)
            .unwrap()
            .unwrap();
        assert!(!hidden.is_visible);
        assert_eq!(hidden.definition_json, definition_json);

        delete_custom_metric(&mut connection, &created.id).unwrap();
        assert!(find_custom_metric_record(&connection, &created.id, false)
            .unwrap()
            .is_none());
        assert!(find_custom_metric_record(&connection, &created.id, true)
            .unwrap()
            .is_some());
    }

    #[test]
    fn service_crud_preserves_immutable_fields_and_reindexes_sort_order() {
        let mut connection = seeded_database();
        let before_default = list_custom_metric_records(&connection, "bank-1")
            .unwrap()
            .remove(0);
        let created =
            create_custom_metric(&mut connection, "bank-1", valid_input(" カスタム ")).unwrap();
        assert_eq!(created.name, "カスタム");
        assert_eq!(created.origin, MetricOrigin::Custom);
        assert_eq!(created.system_key, None);
        assert_eq!(created.sort_order, 3);

        let mut default_input = valid_input("編集した既定");
        default_input.icon = None;
        default_input.is_visible = false;
        let updated_default =
            update_custom_metric(&mut connection, &before_default.id, default_input).unwrap();
        let after_default = find_custom_metric_record(&connection, &before_default.id, false)
            .unwrap()
            .unwrap();
        assert_eq!(updated_default.origin, MetricOrigin::Default);
        assert_eq!(updated_default.system_key, before_default.system_key);
        assert_eq!(after_default.id, before_default.id);
        assert_eq!(after_default.origin, before_default.origin);
        assert_eq!(after_default.system_key, before_default.system_key);
        assert_eq!(after_default.created_at, before_default.created_at);

        let before_custom = find_custom_metric_record(&connection, &created.id, false)
            .unwrap()
            .unwrap();
        let updated_custom =
            update_custom_metric(&mut connection, &created.id, valid_input("更新済み")).unwrap();
        let after_custom = find_custom_metric_record(&connection, &created.id, false)
            .unwrap()
            .unwrap();
        assert_eq!(updated_custom.name, "更新済み");
        assert_eq!(after_custom.id, before_custom.id);
        assert_eq!(after_custom.origin, before_custom.origin);
        assert_eq!(after_custom.system_key, before_custom.system_key);
        assert_eq!(after_custom.created_at, before_custom.created_at);

        let moved = move_custom_metric(&mut connection, &created.id, 0).unwrap();
        assert_eq!(moved[0].id, created.id);
        assert_eq!(
            moved
                .iter()
                .map(|metric| metric.sort_order)
                .collect::<Vec<_>>(),
            vec![0, 1, 2, 3]
        );

        delete_custom_metric(&mut connection, &before_default.id).unwrap();
        let remaining = list_custom_metrics(&connection, "bank-1").unwrap();
        assert_eq!(
            remaining
                .iter()
                .map(|metric| metric.sort_order)
                .collect::<Vec<_>>(),
            vec![0, 1, 2]
        );
        assert_eq!(
            restore_default_custom_metric(
                &mut connection,
                "bank-1",
                before_default.system_key.as_deref().unwrap()
            )
            .unwrap(),
            RestoreDefaultMetricOutcome::Restored
        );
        assert_eq!(
            list_custom_metrics(&connection, "bank-1")
                .unwrap()
                .iter()
                .map(|metric| metric.sort_order)
                .collect::<Vec<_>>(),
            vec![0, 1, 2, 3]
        );
    }

    #[test]
    fn service_validates_input_and_reports_missing_metrics_without_panicking() {
        let mut connection = seeded_database();
        let error = create_custom_metric(&mut connection, "bank-1", valid_input("  ")).unwrap_err();
        assert!(matches!(error, CustomMetricManagementError::Validation(_)));
        assert!(matches!(
            move_custom_metric(&mut connection, "missing", 0).unwrap_err(),
            CustomMetricManagementError::NotFound(_)
        ));
        let first_id = list_custom_metrics(&connection, "bank-1").unwrap()[0]
            .id
            .clone();
        assert!(matches!(
            move_custom_metric(&mut connection, &first_id, -1).unwrap_err(),
            CustomMetricManagementError::Validation(_)
        ));
    }

    fn assert_factory_defaults(connection: &Connection) {
        let metrics = list_custom_metrics(connection, "bank-1").unwrap();
        let templates = default_metric_templates();
        assert_eq!(metrics.len(), templates.len());
        for (index, (metric, template)) in metrics.iter().zip(templates.iter()).enumerate() {
            assert_eq!(metric.name, template.name);
            assert_eq!(metric.icon.as_deref(), Some(template.icon));
            assert_eq!(metric.definition, template.definition);
            assert_eq!(metric.population, default_population_definition());
            assert!(metric.is_visible);
            assert_eq!(metric.sort_order, index as i32);
            assert_eq!(metric.origin, MetricOrigin::Default);
            assert_eq!(metric.system_key.as_deref(), Some(template.system_key));
        }
    }

    #[test]
    fn reset_keeps_factory_defaults_in_factory_state() {
        let mut connection = seeded_database();
        reset_custom_metrics(&mut connection, "bank-1").unwrap();
        assert_factory_defaults(&connection);
    }

    #[test]
    fn reset_replaces_an_edited_default_with_its_template() {
        let mut connection = seeded_database();
        let default = list_custom_metrics(&connection, "bank-1").unwrap()[0].clone();
        update_custom_metric(
            &mut connection,
            &default.id,
            CustomMetricWriteInput {
                name: "変更後".into(),
                is_visible: false,
                ..valid_input("unused")
            },
        )
        .unwrap();
        reset_custom_metrics(&mut connection, "bank-1").unwrap();
        assert_factory_defaults(&connection);
    }

    #[test]
    fn reset_restores_a_deleted_default() {
        let mut connection = seeded_database();
        let default = list_custom_metrics(&connection, "bank-1").unwrap()[1].clone();
        delete_custom_metric(&mut connection, &default.id).unwrap();
        reset_custom_metrics(&mut connection, "bank-1").unwrap();
        assert_factory_defaults(&connection);
        assert!(find_custom_metric_record(&connection, &default.id, false)
            .unwrap()
            .is_some());
    }

    #[test]
    fn reset_deletes_an_added_custom_metric() {
        let mut connection = seeded_database();
        let custom =
            create_custom_metric(&mut connection, "bank-1", valid_input("追加済み")).unwrap();
        reset_custom_metrics(&mut connection, "bank-1").unwrap();
        assert_factory_defaults(&connection);
        assert!(find_custom_metric_record(&connection, &custom.id, false)
            .unwrap()
            .is_none());
    }

    #[test]
    fn reset_restores_edited_and_deleted_defaults_and_deletes_custom_metrics() {
        let mut connection = seeded_database();
        let defaults = list_custom_metrics(&connection, "bank-1").unwrap();
        update_custom_metric(
            &mut connection,
            &defaults[0].id,
            CustomMetricWriteInput {
                name: "編集済み".into(),
                icon: Some("!".into()),
                definition: default_metric_templates()[2].definition.clone(),
                population: default_population_definition(),
                is_visible: false,
            },
        )
        .unwrap();
        delete_custom_metric(&mut connection, &defaults[1].id).unwrap();
        let custom =
            create_custom_metric(&mut connection, "bank-1", valid_input("ユーザー作成")).unwrap();

        reset_custom_metrics(&mut connection, "bank-1").unwrap();

        assert_factory_defaults(&connection);
        assert!(find_custom_metric_record(&connection, &custom.id, false)
            .unwrap()
            .is_none());
        assert!(find_custom_metric_record(&connection, &custom.id, true)
            .unwrap()
            .unwrap()
            .deleted_at
            .is_some());
        let restored = find_custom_metric_record(&connection, &defaults[1].id, false)
            .unwrap()
            .unwrap();
        assert_eq!(restored.id, defaults[1].id);
    }

    #[test]
    fn reset_rolls_back_every_change_when_a_later_default_fails() {
        let mut connection = seeded_database();
        let first = list_custom_metrics(&connection, "bank-1").unwrap()[0].clone();
        update_custom_metric(
            &mut connection,
            &first.id,
            CustomMetricWriteInput {
                name: "ロールバック確認".into(),
                ..valid_input("unused")
            },
        )
        .unwrap();
        let custom =
            create_custom_metric(&mut connection, "bank-1", valid_input("残るCustom")).unwrap();
        connection
            .execute_batch(
                "CREATE TRIGGER fail_metric_reset
                 BEFORE UPDATE ON custom_metrics
                 WHEN NEW.system_key = 'multiple_correct'
                 BEGIN
                   SELECT RAISE(ABORT, 'forced reset failure');
                 END;",
            )
            .unwrap();

        assert!(matches!(
            reset_custom_metrics(&mut connection, "bank-1").unwrap_err(),
            CustomMetricManagementError::Repository(_)
        ));
        let after = list_custom_metrics(&connection, "bank-1").unwrap();
        assert_eq!(
            after
                .iter()
                .find(|metric| metric.id == first.id)
                .unwrap()
                .name,
            "ロールバック確認"
        );
        assert!(after.iter().any(|metric| metric.id == custom.id));
    }
}
