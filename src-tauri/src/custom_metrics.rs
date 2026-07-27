use chrono::{DateTime, SecondsFormat, Utc};
use rusqlite::{params, Connection, OptionalExtension, Row, Transaction};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use thiserror::Error;
use uuid::Uuid;

pub const DSL_VERSION: u32 = 1;
pub const CUSTOM_METRIC_DEFINITION_VERSION: u32 = DSL_VERSION;
pub const POPULATION_DEFINITION_VERSION: u32 = DSL_VERSION;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CustomMetric {
    pub id: String,
    pub question_bank_id: String,
    pub name: String,
    pub icon: Option<String>,
    pub definition_version: u32,
    pub definition: MetricDefinition,
    pub population: PopulationDefinition,
    pub is_visible: bool,
    pub sort_order: i32,
    pub origin: MetricOrigin,
    pub system_key: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MetricOrigin {
    Default,
    Custom,
}

#[derive(Debug, Clone, PartialEq)]
pub struct DefaultMetricTemplate {
    pub name: &'static str,
    pub icon: &'static str,
    pub system_key: &'static str,
    pub definition: MetricDefinition,
}

#[derive(Debug, Clone, PartialEq)]
pub struct CustomMetricRecord {
    pub id: String,
    pub question_bank_id: String,
    pub name: String,
    pub icon: Option<String>,
    pub definition_json: String,
    pub definition_version: u32,
    pub population_json: String,
    pub is_visible: bool,
    pub sort_order: i32,
    pub origin: MetricOrigin,
    pub system_key: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub deleted_at: Option<String>,
}

impl CustomMetricRecord {
    pub fn from_metric(
        metric: &CustomMetric,
        created_at: String,
        updated_at: String,
        deleted_at: Option<String>,
    ) -> Result<Self, String> {
        if metric.definition_version != metric.definition.version {
            return Err("definition_versionとdefinition.versionが一致しません。".into());
        }
        Ok(Self {
            id: metric.id.clone(),
            question_bank_id: metric.question_bank_id.clone(),
            name: metric.name.clone(),
            icon: metric.icon.clone(),
            definition_json: serialize_definition(&metric.definition)
                .map_err(|error| error.to_string())?,
            definition_version: metric.definition_version,
            population_json: serialize_population(&metric.population)
                .map_err(|error| error.to_string())?,
            is_visible: metric.is_visible,
            sort_order: metric.sort_order,
            origin: metric.origin,
            system_key: metric.system_key.clone(),
            created_at,
            updated_at,
            deleted_at,
        })
    }

    pub fn to_metric(&self) -> Result<CustomMetric, String> {
        let definition =
            deserialize_definition(&self.definition_json).map_err(|error| error.to_string())?;
        if self.definition_version != definition.version {
            return Err("definition_versionとdefinition.versionが一致しません。".into());
        }
        Ok(CustomMetric {
            id: self.id.clone(),
            question_bank_id: self.question_bank_id.clone(),
            name: self.name.clone(),
            icon: self.icon.clone(),
            definition_version: self.definition_version,
            definition,
            population: deserialize_population(&self.population_json)
                .map_err(|error| error.to_string())?,
            is_visible: self.is_visible,
            sort_order: self.sort_order,
            origin: self.origin,
            system_key: self.system_key.clone(),
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RestoreDefaultMetricOutcome {
    Unchanged,
    Restored,
    Inserted,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DslDefinition<Clause> {
    pub version: u32,
    pub operator: BooleanOperator,
    pub clauses: Vec<Clause>,
}

pub type MetricDefinition = DslDefinition<MetricClause>;
pub type PopulationDefinition = DslDefinition<PopulationClause>;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BooleanOperator {
    And,
    Or,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum MetricClause {
    AttemptCount {
        #[serde(rename = "attemptScope")]
        attempt_scope: AttemptScope,
        r#where: AttemptFilterGroup,
        count: CountComparison,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum PopulationClause {
    ProblemScope { scope: ProblemScope },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProblemScope {
    NonExcluded,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AttemptScope {
    All,
    Latest,
    ExceptLatest,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AttemptFilterGroup {
    pub operator: BooleanOperator,
    pub clauses: Vec<AttemptPredicate>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum AttemptPredicate {
    Field {
        field: AttemptField,
        operator: ComparisonOperator,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        value: Option<Value>,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AttemptField {
    Result,
    Confidence,
    AttemptNumber,
    RoundId,
    RoundNumber,
    AnsweredAt,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ComparisonOperator {
    Eq,
    Neq,
    Gte,
    Lte,
    Between,
    IsNull,
    IsNotNull,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CountComparison {
    pub operator: CountOperator,
    pub value: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CountOperator {
    Eq,
    Gte,
    Lte,
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum MetricDefinitionError {
    #[error("カスタムメトリクス定義のJSONが不正です: {0}")]
    InvalidJson(String),
    #[error("未対応のdefinition versionです: {0}")]
    UnsupportedVersion(u32),
    #[error("version 1ではoperatorはandのみ使用できます")]
    UnsupportedBooleanOperator,
    #[error("メトリクス条件を1件以上指定してください")]
    EmptyMetricClauses,
    #[error("{field:?}では{operator:?}を使用できません")]
    UnsupportedFieldOperator {
        field: AttemptField,
        operator: ComparisonOperator,
    },
    #[error("{field:?}の値が不正です")]
    InvalidFieldValue { field: AttemptField },
    #[error("{operator:?}にはvalueを指定できません")]
    UnexpectedValue { operator: ComparisonOperator },
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum PopulationDefinitionError {
    #[error("Population定義のJSONが不正です: {0}")]
    InvalidJson(String),
    #[error("未対応のPopulation definition versionです: {0}")]
    UnsupportedVersion(u32),
    #[error("Population version 1ではoperatorはandのみ使用できます")]
    UnsupportedBooleanOperator,
    #[error("Population条件を1件以上指定してください")]
    EmptyClauses,
}

pub fn deserialize_definition(json: &str) -> Result<MetricDefinition, MetricDefinitionError> {
    let definition: MetricDefinition = serde_json::from_str(json)
        .map_err(|error| MetricDefinitionError::InvalidJson(error.to_string()))?;
    validate_definition(&definition)?;
    Ok(definition)
}

pub fn serialize_definition(
    definition: &MetricDefinition,
) -> Result<String, MetricDefinitionError> {
    validate_definition(definition)?;
    serde_json::to_string(definition)
        .map_err(|error| MetricDefinitionError::InvalidJson(error.to_string()))
}

pub fn validate_definition(definition: &MetricDefinition) -> Result<(), MetricDefinitionError> {
    if definition.version != CUSTOM_METRIC_DEFINITION_VERSION {
        return Err(MetricDefinitionError::UnsupportedVersion(
            definition.version,
        ));
    }
    validate_and_operator(definition.operator)?;
    if definition.clauses.is_empty() {
        return Err(MetricDefinitionError::EmptyMetricClauses);
    }
    for clause in &definition.clauses {
        match clause {
            MetricClause::AttemptCount { r#where, .. } => {
                validate_and_operator(r#where.operator)?;
                for predicate in &r#where.clauses {
                    validate_predicate(predicate)?;
                }
            }
        }
    }
    Ok(())
}

pub fn deserialize_population(
    json: &str,
) -> Result<PopulationDefinition, PopulationDefinitionError> {
    let definition: PopulationDefinition = serde_json::from_str(json)
        .map_err(|error| PopulationDefinitionError::InvalidJson(error.to_string()))?;
    validate_population(&definition)?;
    Ok(definition)
}

pub fn serialize_population(
    definition: &PopulationDefinition,
) -> Result<String, PopulationDefinitionError> {
    validate_population(definition)?;
    serde_json::to_string(definition)
        .map_err(|error| PopulationDefinitionError::InvalidJson(error.to_string()))
}

pub fn validate_population(
    definition: &PopulationDefinition,
) -> Result<(), PopulationDefinitionError> {
    if definition.version != POPULATION_DEFINITION_VERSION {
        return Err(PopulationDefinitionError::UnsupportedVersion(
            definition.version,
        ));
    }
    if definition.operator != BooleanOperator::And {
        return Err(PopulationDefinitionError::UnsupportedBooleanOperator);
    }
    if definition.clauses.is_empty() {
        return Err(PopulationDefinitionError::EmptyClauses);
    }
    Ok(())
}

pub fn default_population_definition() -> PopulationDefinition {
    DslDefinition {
        version: POPULATION_DEFINITION_VERSION,
        operator: BooleanOperator::And,
        clauses: vec![PopulationClause::ProblemScope {
            scope: ProblemScope::NonExcluded,
        }],
    }
}

pub fn save_custom_metric(
    connection: &Connection,
    record: &CustomMetricRecord,
) -> Result<(), String> {
    record.to_metric()?;
    connection
        .execute(
            "INSERT INTO custom_metrics(
               id, question_bank_id, name, icon, definition_json, definition_version,
               population_json, is_visible, sort_order, origin, system_key,
               created_at, updated_at, deleted_at
             ) VALUES (
               ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14
             )
             ON CONFLICT(id) DO UPDATE SET
               question_bank_id=excluded.question_bank_id,
               name=excluded.name,
               icon=excluded.icon,
               definition_json=excluded.definition_json,
               definition_version=excluded.definition_version,
               population_json=excluded.population_json,
               is_visible=excluded.is_visible,
               sort_order=excluded.sort_order,
               origin=excluded.origin,
               system_key=excluded.system_key,
               updated_at=excluded.updated_at,
               deleted_at=excluded.deleted_at",
            params![
                record.id,
                record.question_bank_id,
                record.name,
                record.icon,
                record.definition_json,
                record.definition_version,
                record.population_json,
                record.is_visible,
                record.sort_order,
                origin_value(record.origin),
                record.system_key,
                record.created_at,
                record.updated_at,
                record.deleted_at,
            ],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

pub fn load_custom_metrics(
    connection: &Connection,
    question_bank_id: &str,
    include_deleted: bool,
) -> Result<Vec<CustomMetricRecord>, String> {
    let sql = if include_deleted {
        "SELECT id, question_bank_id, name, icon, definition_json, definition_version,
                population_json, is_visible, sort_order, origin, system_key,
                created_at, updated_at, deleted_at
         FROM custom_metrics
         WHERE question_bank_id = ?1
         ORDER BY sort_order, id"
    } else {
        "SELECT id, question_bank_id, name, icon, definition_json, definition_version,
                population_json, is_visible, sort_order, origin, system_key,
                created_at, updated_at, deleted_at
         FROM custom_metrics
         WHERE question_bank_id = ?1 AND deleted_at IS NULL
         ORDER BY sort_order, id"
    };
    let mut statement = connection.prepare(sql).map_err(|error| error.to_string())?;
    let records = statement
        .query_map([question_bank_id], custom_metric_record_from_row)
        .map_err(|error| error.to_string())?
        .map(|row| row.map_err(|error| error.to_string()))
        .collect::<Result<Vec<_>, _>>()?;
    for record in &records {
        record.to_metric()?;
    }
    Ok(records)
}

pub fn soft_delete_custom_metric(
    connection: &Connection,
    id: &str,
    timestamp: &str,
) -> Result<bool, String> {
    connection
        .execute(
            "UPDATE custom_metrics
             SET deleted_at = ?2, updated_at = ?2
             WHERE id = ?1 AND deleted_at IS NULL",
            params![id, timestamp],
        )
        .map(|changed| changed > 0)
        .map_err(|error| error.to_string())
}

pub fn seed_default_metrics(
    transaction: &Transaction,
    question_bank_id: &str,
) -> Result<(), String> {
    let timestamp = persistence_now();
    for (sort_order, template) in default_metric_templates().into_iter().enumerate() {
        let exists = transaction
            .query_row(
                "SELECT EXISTS(
                   SELECT 1 FROM custom_metrics
                   WHERE question_bank_id = ?1
                     AND system_key = ?2
                 )",
                params![question_bank_id, template.system_key],
                |row| row.get::<_, bool>(0),
            )
            .map_err(|error| error.to_string())?;
        if !exists {
            let record = new_default_metric_record(
                question_bank_id,
                &template,
                sort_order as i32,
                timestamp.clone(),
            )?;
            save_custom_metric(transaction, &record)?;
        }
    }
    Ok(())
}

pub fn restore_default_metric(
    transaction: &Transaction,
    question_bank_id: &str,
    system_key: &str,
) -> Result<RestoreDefaultMetricOutcome, String> {
    apply_default_metric_template(transaction, question_bank_id, system_key, false)
}

pub fn reset_default_metric(
    transaction: &Transaction,
    question_bank_id: &str,
    system_key: &str,
) -> Result<RestoreDefaultMetricOutcome, String> {
    apply_default_metric_template(transaction, question_bank_id, system_key, true)
}

fn apply_default_metric_template(
    transaction: &Transaction,
    question_bank_id: &str,
    system_key: &str,
    reset_active: bool,
) -> Result<RestoreDefaultMetricOutcome, String> {
    let template_index = default_metric_templates()
        .iter()
        .position(|template| template.system_key == system_key)
        .ok_or_else(|| format!("未知のデフォルトメトリクスです: {system_key}"))?;

    let existing = transaction
        .query_row(
            "SELECT id, created_at, deleted_at
             FROM custom_metrics
             WHERE question_bank_id = ?1 AND system_key = ?2
             ORDER BY (deleted_at IS NULL) DESC, updated_at DESC, id
             LIMIT 1",
            params![question_bank_id, system_key],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<String>>(2)?,
                ))
            },
        )
        .optional()
        .map_err(|error| error.to_string())?;

    match existing {
        Some((_, _, None)) if !reset_active => Ok(RestoreDefaultMetricOutcome::Unchanged),
        Some((id, created_at, None)) => {
            let template = &default_metric_templates()[template_index];
            let record = build_default_metric_record(
                question_bank_id,
                template,
                template_index as i32,
                id,
                created_at,
                persistence_now(),
            )?;
            save_custom_metric(transaction, &record)?;
            Ok(RestoreDefaultMetricOutcome::Restored)
        }
        Some((id, created_at, Some(_))) => {
            let template = &default_metric_templates()[template_index];
            let record = build_default_metric_record(
                question_bank_id,
                template,
                template_index as i32,
                id,
                created_at,
                persistence_now(),
            )?;
            save_custom_metric(transaction, &record)?;
            Ok(RestoreDefaultMetricOutcome::Restored)
        }
        None => {
            let template = &default_metric_templates()[template_index];
            let record = new_default_metric_record(
                question_bank_id,
                template,
                template_index as i32,
                persistence_now(),
            )?;
            save_custom_metric(transaction, &record)?;
            Ok(RestoreDefaultMetricOutcome::Inserted)
        }
    }
}

fn new_default_metric_record(
    question_bank_id: &str,
    template: &DefaultMetricTemplate,
    sort_order: i32,
    timestamp: String,
) -> Result<CustomMetricRecord, String> {
    build_default_metric_record(
        question_bank_id,
        template,
        sort_order,
        Uuid::new_v4().to_string(),
        timestamp.clone(),
        timestamp,
    )
}

fn build_default_metric_record(
    question_bank_id: &str,
    template: &DefaultMetricTemplate,
    sort_order: i32,
    id: String,
    created_at: String,
    updated_at: String,
) -> Result<CustomMetricRecord, String> {
    CustomMetricRecord::from_metric(
        &CustomMetric {
            id,
            question_bank_id: question_bank_id.into(),
            name: template.name.into(),
            icon: Some(template.icon.into()),
            definition_version: CUSTOM_METRIC_DEFINITION_VERSION,
            definition: template.definition.clone(),
            population: default_population_definition(),
            is_visible: true,
            sort_order,
            origin: MetricOrigin::Default,
            system_key: Some(template.system_key.into()),
        },
        created_at,
        updated_at,
        None,
    )
}

fn custom_metric_record_from_row(row: &Row<'_>) -> rusqlite::Result<CustomMetricRecord> {
    let origin = match row.get::<_, String>(9)?.as_str() {
        "default" => MetricOrigin::Default,
        "custom" => MetricOrigin::Custom,
        value => {
            return Err(rusqlite::Error::FromSqlConversionFailure(
                9,
                rusqlite::types::Type::Text,
                format!("未知のoriginです: {value}").into(),
            ))
        }
    };
    Ok(CustomMetricRecord {
        id: row.get(0)?,
        question_bank_id: row.get(1)?,
        name: row.get(2)?,
        icon: row.get(3)?,
        definition_json: row.get(4)?,
        definition_version: row.get(5)?,
        population_json: row.get(6)?,
        is_visible: row.get(7)?,
        sort_order: row.get(8)?,
        origin,
        system_key: row.get(10)?,
        created_at: row.get(11)?,
        updated_at: row.get(12)?,
        deleted_at: row.get(13)?,
    })
}

fn origin_value(origin: MetricOrigin) -> &'static str {
    match origin {
        MetricOrigin::Default => "default",
        MetricOrigin::Custom => "custom",
    }
}

fn persistence_now() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

pub fn default_metric_templates() -> Vec<DefaultMetricTemplate> {
    vec![
        default_metric(
            "正解歴",
            "○",
            "ever_correct",
            vec![field_predicate(AttemptField::Result, "correct")],
            1,
        ),
        default_metric(
            "自信あり正解歴",
            "◎",
            "ever_confident_correct",
            vec![
                field_predicate(AttemptField::Result, "correct"),
                field_predicate(AttemptField::Confidence, "high"),
            ],
            1,
        ),
        default_metric(
            "複数正解歴",
            "★",
            "multiple_correct",
            vec![field_predicate(AttemptField::Result, "correct")],
            2,
        ),
    ]
}

fn default_metric(
    name: &'static str,
    icon: &'static str,
    system_key: &'static str,
    predicates: Vec<AttemptPredicate>,
    minimum_count: u32,
) -> DefaultMetricTemplate {
    DefaultMetricTemplate {
        name,
        icon,
        system_key,
        definition: DslDefinition {
            version: CUSTOM_METRIC_DEFINITION_VERSION,
            operator: BooleanOperator::And,
            clauses: vec![MetricClause::AttemptCount {
                attempt_scope: AttemptScope::All,
                r#where: AttemptFilterGroup {
                    operator: BooleanOperator::And,
                    clauses: predicates,
                },
                count: CountComparison {
                    operator: CountOperator::Gte,
                    value: minimum_count,
                },
            }],
        },
    }
}

fn field_predicate(field: AttemptField, value: &str) -> AttemptPredicate {
    AttemptPredicate::Field {
        field,
        operator: ComparisonOperator::Eq,
        value: Some(Value::String(value.into())),
    }
}

fn validate_and_operator(operator: BooleanOperator) -> Result<(), MetricDefinitionError> {
    if operator == BooleanOperator::And {
        Ok(())
    } else {
        Err(MetricDefinitionError::UnsupportedBooleanOperator)
    }
}

fn validate_predicate(predicate: &AttemptPredicate) -> Result<(), MetricDefinitionError> {
    let AttemptPredicate::Field {
        field,
        operator,
        value,
    } = predicate;

    if matches!(
        operator,
        ComparisonOperator::IsNull | ComparisonOperator::IsNotNull
    ) {
        return if value.is_none() {
            Ok(())
        } else {
            Err(MetricDefinitionError::UnexpectedValue {
                operator: *operator,
            })
        };
    }

    let Some(value) = value else {
        return Err(MetricDefinitionError::InvalidFieldValue { field: *field });
    };

    let valid = match field {
        AttemptField::Result => {
            matches!(operator, ComparisonOperator::Eq | ComparisonOperator::Neq)
                && string_in(value, &["correct", "partial", "incorrect"])
        }
        AttemptField::Confidence => {
            matches!(operator, ComparisonOperator::Eq | ComparisonOperator::Neq)
                && string_in(value, &["high", "medium", "low"])
        }
        AttemptField::AttemptNumber | AttemptField::RoundNumber => {
            numeric_operator(*operator) && positive_integer_or_range(value, *operator)
        }
        AttemptField::RoundId => {
            matches!(operator, ComparisonOperator::Eq | ComparisonOperator::Neq)
                && value.as_str().is_some_and(|item| !item.trim().is_empty())
        }
        AttemptField::AnsweredAt => {
            ordered_operator(*operator) && timestamp_or_range(value, *operator)
        }
    };

    if valid {
        Ok(())
    } else if !operator_supported_for_field(*field, *operator) {
        Err(MetricDefinitionError::UnsupportedFieldOperator {
            field: *field,
            operator: *operator,
        })
    } else {
        Err(MetricDefinitionError::InvalidFieldValue { field: *field })
    }
}

fn operator_supported_for_field(field: AttemptField, operator: ComparisonOperator) -> bool {
    if matches!(
        operator,
        ComparisonOperator::IsNull | ComparisonOperator::IsNotNull
    ) {
        return true;
    }
    match field {
        AttemptField::Result | AttemptField::Confidence | AttemptField::RoundId => {
            matches!(operator, ComparisonOperator::Eq | ComparisonOperator::Neq)
        }
        AttemptField::AttemptNumber | AttemptField::RoundNumber => numeric_operator(operator),
        AttemptField::AnsweredAt => ordered_operator(operator),
    }
}

fn numeric_operator(operator: ComparisonOperator) -> bool {
    matches!(
        operator,
        ComparisonOperator::Eq
            | ComparisonOperator::Neq
            | ComparisonOperator::Gte
            | ComparisonOperator::Lte
            | ComparisonOperator::Between
    )
}

fn ordered_operator(operator: ComparisonOperator) -> bool {
    matches!(
        operator,
        ComparisonOperator::Eq
            | ComparisonOperator::Neq
            | ComparisonOperator::Gte
            | ComparisonOperator::Lte
            | ComparisonOperator::Between
    )
}

fn string_in(value: &Value, allowed: &[&str]) -> bool {
    value.as_str().is_some_and(|item| allowed.contains(&item))
}

fn positive_integer(value: &Value) -> bool {
    value.as_u64().is_some_and(|item| item >= 1)
}

fn positive_integer_or_range(value: &Value, operator: ComparisonOperator) -> bool {
    if operator == ComparisonOperator::Between {
        let Some(items) = valid_pair(value, positive_integer) else {
            return false;
        };
        items[0].as_u64() <= items[1].as_u64()
    } else {
        positive_integer(value)
    }
}

fn timestamp(value: &Value) -> bool {
    value
        .as_str()
        .is_some_and(|item| DateTime::parse_from_rfc3339(item).is_ok())
}

fn timestamp_or_range(value: &Value, operator: ComparisonOperator) -> bool {
    if operator == ComparisonOperator::Between {
        let Some(items) = valid_pair(value, timestamp) else {
            return false;
        };
        DateTime::parse_from_rfc3339(items[0].as_str().unwrap()).unwrap()
            <= DateTime::parse_from_rfc3339(items[1].as_str().unwrap()).unwrap()
    } else {
        timestamp(value)
    }
}

fn valid_pair(value: &Value, validate_item: fn(&Value) -> bool) -> Option<&[Value]> {
    let Some(items) = value.as_array() else {
        return None;
    };
    (items.len() == 2 && validate_item(&items[0]) && validate_item(&items[1]))
        .then_some(items.as_slice())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn persistence_database() -> Connection {
        let connection = Connection::open_in_memory().expect("in-memory database");
        connection
            .execute_batch(
                "PRAGMA foreign_keys = ON;
                 CREATE TABLE materials (
                   id TEXT PRIMARY KEY,
                   title TEXT NOT NULL,
                   created_at TEXT NOT NULL,
                   updated_at TEXT NOT NULL
                 );
                 CREATE TABLE question_banks (
                   id TEXT PRIMARY KEY,
                   material_id TEXT NOT NULL REFERENCES materials(id) ON DELETE CASCADE,
                   title TEXT NOT NULL,
                   created_at TEXT NOT NULL,
                   updated_at TEXT NOT NULL
                 );
                 INSERT INTO materials(id,title,created_at,updated_at)
                   VALUES ('material-1','教材','2026-01-01','2026-01-01');
                 INSERT INTO question_banks(id,material_id,title,created_at,updated_at)
                   VALUES ('bank-1','material-1','教材','2026-01-01','2026-01-01');",
            )
            .expect("base schema");
        connection
            .execute_batch(include_str!("../migrations/005_custom_metrics.sql"))
            .expect("migration 005");
        connection
    }

    fn custom_record(id: &str) -> CustomMetricRecord {
        let template = &default_metric_templates()[0];
        let metric = CustomMetric {
            id: id.into(),
            question_bank_id: "bank-1".into(),
            name: "カスタム正解".into(),
            icon: None,
            definition_version: CUSTOM_METRIC_DEFINITION_VERSION,
            definition: template.definition.clone(),
            population: default_population_definition(),
            is_visible: true,
            sort_order: 10,
            origin: MetricOrigin::Custom,
            system_key: None,
        };
        CustomMetricRecord::from_metric(
            &metric,
            "2026-01-01T00:00:00Z".into(),
            "2026-01-01T00:00:00Z".into(),
            None,
        )
        .expect("custom metric record")
    }

    fn definition(where_clauses: Vec<AttemptPredicate>) -> MetricDefinition {
        MetricDefinition {
            version: 1,
            operator: BooleanOperator::And,
            clauses: vec![MetricClause::AttemptCount {
                attempt_scope: AttemptScope::All,
                r#where: AttemptFilterGroup {
                    operator: BooleanOperator::And,
                    clauses: where_clauses,
                },
                count: CountComparison {
                    operator: CountOperator::Gte,
                    value: 1,
                },
            }],
        }
    }

    fn field(
        field: AttemptField,
        operator: ComparisonOperator,
        value: Option<Value>,
    ) -> AttemptPredicate {
        AttemptPredicate::Field {
            field,
            operator,
            value,
        }
    }

    #[test]
    fn definition_round_trips_as_camel_case_json() {
        let source = definition(vec![
            field(
                AttemptField::Result,
                ComparisonOperator::Eq,
                Some(json!("correct")),
            ),
            field(
                AttemptField::Confidence,
                ComparisonOperator::Eq,
                Some(json!("high")),
            ),
        ]);
        let json = serialize_definition(&source).unwrap();
        assert!(json.contains("\"attemptScope\":\"all\""));
        assert_eq!(deserialize_definition(&json).unwrap(), source);
    }

    #[test]
    fn all_attempt_scopes_deserialize() {
        for scope in ["all", "latest", "except_latest"] {
            let json = format!(
                r#"{{"version":1,"operator":"and","clauses":[{{"kind":"attempt_count","attemptScope":"{scope}","where":{{"operator":"and","clauses":[]}},"count":{{"operator":"gte","value":1}}}}]}}"#
            );
            assert!(deserialize_definition(&json).is_ok());
        }
    }

    #[test]
    fn supported_fields_and_operators_validate() {
        let source = definition(vec![
            field(
                AttemptField::Result,
                ComparisonOperator::Eq,
                Some(json!("correct")),
            ),
            field(
                AttemptField::Confidence,
                ComparisonOperator::Neq,
                Some(json!("low")),
            ),
            field(
                AttemptField::AttemptNumber,
                ComparisonOperator::Gte,
                Some(json!(2)),
            ),
            field(
                AttemptField::RoundId,
                ComparisonOperator::Eq,
                Some(json!("round-1")),
            ),
            field(
                AttemptField::RoundNumber,
                ComparisonOperator::Between,
                Some(json!([1, 3])),
            ),
            field(
                AttemptField::AnsweredAt,
                ComparisonOperator::IsNotNull,
                None,
            ),
        ]);
        assert_eq!(validate_definition(&source), Ok(()));
    }

    #[test]
    fn rejects_unknown_version_and_or_in_version_one() {
        let mut source = definition(vec![]);
        source.version = 2;
        assert_eq!(
            validate_definition(&source),
            Err(MetricDefinitionError::UnsupportedVersion(2))
        );
        source.version = 1;
        source.operator = BooleanOperator::Or;
        assert_eq!(
            validate_definition(&source),
            Err(MetricDefinitionError::UnsupportedBooleanOperator)
        );
    }

    #[test]
    fn rejects_unknown_json_members_and_enum_values() {
        let unknown_field = r#"{"version":1,"operator":"and","clauses":[],"sql":"select 1"}"#;
        assert!(matches!(
            deserialize_definition(unknown_field),
            Err(MetricDefinitionError::InvalidJson(_))
        ));
        let unknown_operator = r#"{"version":1,"operator":"xor","clauses":[]}"#;
        assert!(matches!(
            deserialize_definition(unknown_operator),
            Err(MetricDefinitionError::InvalidJson(_))
        ));
    }

    #[test]
    fn rejects_invalid_field_operator_and_value_combinations() {
        assert!(matches!(
            validate_definition(&definition(vec![field(
                AttemptField::Result,
                ComparisonOperator::Gte,
                Some(json!("correct"))
            )])),
            Err(MetricDefinitionError::UnsupportedFieldOperator { .. })
        ));
        assert!(matches!(
            validate_definition(&definition(vec![field(
                AttemptField::AttemptNumber,
                ComparisonOperator::Eq,
                Some(json!(0))
            )])),
            Err(MetricDefinitionError::InvalidFieldValue { .. })
        ));
        assert!(matches!(
            validate_definition(&definition(vec![field(
                AttemptField::AnsweredAt,
                ComparisonOperator::Eq,
                Some(json!("not-a-date"))
            )])),
            Err(MetricDefinitionError::InvalidFieldValue { .. })
        ));
        assert!(matches!(
            validate_definition(&definition(vec![field(
                AttemptField::AnsweredAt,
                ComparisonOperator::IsNull,
                Some(Value::Null)
            )])),
            Err(MetricDefinitionError::UnexpectedValue { .. })
        ));
    }

    #[test]
    fn default_metric_definitions_are_valid_and_stable() {
        let templates = default_metric_templates();
        assert_eq!(
            templates
                .iter()
                .map(|item| item.system_key)
                .collect::<Vec<_>>(),
            vec!["ever_correct", "ever_confident_correct", "multiple_correct"]
        );
        assert_eq!(
            templates.iter().map(|item| item.name).collect::<Vec<_>>(),
            vec!["正解歴", "自信あり正解歴", "複数正解歴"]
        );
        for template in templates {
            assert_eq!(validate_definition(&template.definition), Ok(()));
        }
        let MetricClause::AttemptCount { count, .. } =
            &default_metric_templates()[2].definition.clauses[0];
        assert_eq!(count.value, 2);
    }

    #[test]
    fn population_definition_round_trips_as_json() {
        let source = default_population_definition();
        let json = serialize_population(&source).unwrap();
        assert_eq!(
            json,
            r#"{"version":1,"operator":"and","clauses":[{"kind":"problem_scope","scope":"non_excluded"}]}"#
        );
        assert_eq!(deserialize_population(&json).unwrap(), source);
    }

    #[test]
    fn default_population_is_non_excluded_problems() {
        let definition = default_population_definition();
        assert_eq!(validate_population(&definition), Ok(()));
        assert_eq!(
            definition.clauses,
            vec![PopulationClause::ProblemScope {
                scope: ProblemScope::NonExcluded
            }]
        );
    }

    #[test]
    fn rejects_invalid_population_version_operator_scope_and_members() {
        let mut definition = default_population_definition();
        definition.version = 2;
        assert_eq!(
            validate_population(&definition),
            Err(PopulationDefinitionError::UnsupportedVersion(2))
        );
        definition.version = 1;
        definition.operator = BooleanOperator::Or;
        assert_eq!(
            validate_population(&definition),
            Err(PopulationDefinitionError::UnsupportedBooleanOperator)
        );

        for json in [
            r#"{"version":1,"operator":"and","clauses":[{"kind":"problem_scope","scope":"all"}]}"#,
            r#"{"version":1,"operator":"and","clauses":[{"kind":"problem_scope","scope":"non_excluded","sql":"select 1"}]}"#,
        ] {
            assert!(matches!(
                deserialize_population(json),
                Err(PopulationDefinitionError::InvalidJson(_))
            ));
        }
    }

    #[test]
    fn saves_and_loads_validated_metric_and_population_json() {
        let connection = persistence_database();
        let record = custom_record("metric-custom");
        save_custom_metric(&connection, &record).expect("save metric");

        let loaded = load_custom_metrics(&connection, "bank-1", false).expect("load metrics");
        assert_eq!(loaded, vec![record.clone()]);
        assert_eq!(loaded[0].to_metric().unwrap(), record.to_metric().unwrap());

        let invalid = CustomMetricRecord {
            definition_json: r#"{"version":1,"operator":"and","clauses":[]}"#.into(),
            ..custom_record("invalid")
        };
        assert!(save_custom_metric(&connection, &invalid).is_err());

        let mut updated = record.clone();
        updated.name = "更新した名称".into();
        updated.updated_at = "2026-02-01T00:00:00Z".into();
        save_custom_metric(&connection, &updated).expect("update metric");
        let reloaded = load_custom_metrics(&connection, "bank-1", false).unwrap();
        assert_eq!(reloaded[0].name, "更新した名称");
        assert_eq!(reloaded[0].created_at, record.created_at);
    }

    #[test]
    fn rejects_semantically_invalid_dsl_when_loading() {
        let connection = persistence_database();
        let record = custom_record("invalid-read");
        connection
            .execute(
                "INSERT INTO custom_metrics(
                   id,question_bank_id,name,definition_json,definition_version,
                   population_json,is_visible,sort_order,origin,
                   created_at,updated_at
                 ) VALUES (?1,?2,?3,?4,1,?5,1,0,'custom',?6,?6)",
                params![
                    record.id,
                    record.question_bank_id,
                    record.name,
                    r#"{"version":1,"operator":"and","clauses":[]}"#,
                    record.population_json,
                    record.created_at,
                ],
            )
            .expect("database accepts syntactically valid JSON");
        assert!(load_custom_metrics(&connection, "bank-1", false).is_err());
    }

    #[test]
    fn logically_deletes_metric_and_excludes_it_from_normal_load() {
        let connection = persistence_database();
        save_custom_metric(&connection, &custom_record("metric-delete")).unwrap();
        assert!(
            soft_delete_custom_metric(&connection, "metric-delete", "2026-02-01T00:00:00Z")
                .unwrap()
        );
        assert!(load_custom_metrics(&connection, "bank-1", false)
            .unwrap()
            .is_empty());
        let deleted = load_custom_metrics(&connection, "bank-1", true).unwrap();
        assert_eq!(
            deleted[0].deleted_at.as_deref(),
            Some("2026-02-01T00:00:00Z")
        );
    }

    #[test]
    fn partial_unique_rejects_active_duplicate_and_allows_deleted_duplicate() {
        let mut connection = persistence_database();
        let transaction = connection.transaction().unwrap();
        seed_default_metrics(&transaction, "bank-1").unwrap();
        transaction.commit().unwrap();

        let mut duplicate = load_custom_metrics(&connection, "bank-1", false).unwrap()[0].clone();
        duplicate.id = "duplicate-active".into();
        assert!(save_custom_metric(&connection, &duplicate).is_err());

        duplicate.deleted_at = Some("2026-02-01T00:00:00Z".into());
        assert!(save_custom_metric(&connection, &duplicate).is_ok());
    }

    #[test]
    fn restores_deleted_default_without_replacing_identity_or_created_at() {
        let mut connection = persistence_database();
        let transaction = connection.transaction().unwrap();
        seed_default_metrics(&transaction, "bank-1").unwrap();
        transaction.commit().unwrap();
        let original = load_custom_metrics(&connection, "bank-1", false).unwrap()[0].clone();
        let mut edited = original.clone();
        edited.name = "ユーザー編集名".into();
        edited.icon = Some("!".into());
        edited.definition_json =
            serialize_definition(&default_metric_templates()[2].definition).unwrap();
        edited.population_json = serde_json::to_string_pretty(&default_population_definition())
            .expect("edited population JSON");
        edited.is_visible = false;
        edited.sort_order = 99;
        edited.updated_at = "2026-01-15T00:00:00Z".into();
        save_custom_metric(&connection, &edited).unwrap();
        soft_delete_custom_metric(&connection, &original.id, "2026-02-01T00:00:00Z").unwrap();

        let transaction = connection.transaction().unwrap();
        seed_default_metrics(&transaction, "bank-1").unwrap();
        transaction.commit().unwrap();
        assert!(!load_custom_metrics(&connection, "bank-1", false)
            .unwrap()
            .iter()
            .any(|item| item.system_key == original.system_key));

        let transaction = connection.transaction().unwrap();
        assert_eq!(
            restore_default_metric(
                &transaction,
                "bank-1",
                original.system_key.as_deref().unwrap()
            )
            .unwrap(),
            RestoreDefaultMetricOutcome::Restored
        );
        transaction.commit().unwrap();

        let restored = load_custom_metrics(&connection, "bank-1", false).unwrap();
        let restored = restored
            .iter()
            .find(|item| item.system_key == original.system_key)
            .unwrap();
        assert_eq!(restored.id, original.id);
        assert_eq!(restored.created_at, original.created_at);
        assert!(restored.deleted_at.is_none());
        assert_ne!(restored.updated_at, "2026-02-01T00:00:00Z");
        let template = &default_metric_templates()[0];
        assert_eq!(restored.name, template.name);
        assert_eq!(restored.icon.as_deref(), Some(template.icon));
        assert_eq!(
            restored.definition_json,
            serialize_definition(&template.definition).unwrap()
        );
        assert_eq!(
            restored.definition_version,
            CUSTOM_METRIC_DEFINITION_VERSION
        );
        assert_eq!(
            restored.population_json,
            serialize_population(&default_population_definition()).unwrap()
        );
        assert!(restored.is_visible);
        assert_eq!(restored.sort_order, 0);
    }

    #[test]
    fn restore_is_noop_for_active_default_and_inserts_missing_default() {
        let mut connection = persistence_database();
        let transaction = connection.transaction().unwrap();
        seed_default_metrics(&transaction, "bank-1").unwrap();
        transaction.commit().unwrap();
        let active = load_custom_metrics(&connection, "bank-1", false).unwrap()[0].clone();

        let transaction = connection.transaction().unwrap();
        assert_eq!(
            restore_default_metric(
                &transaction,
                "bank-1",
                active.system_key.as_deref().unwrap()
            )
            .unwrap(),
            RestoreDefaultMetricOutcome::Unchanged
        );
        transaction.commit().unwrap();
        let unchanged = load_custom_metrics(&connection, "bank-1", false).unwrap();
        let unchanged = unchanged.iter().find(|item| item.id == active.id).unwrap();
        assert_eq!(unchanged.updated_at, active.updated_at);

        connection
            .execute(
                "DELETE FROM custom_metrics WHERE system_key = 'multiple_correct'",
                [],
            )
            .unwrap();
        let transaction = connection.transaction().unwrap();
        assert_eq!(
            restore_default_metric(&transaction, "bank-1", "multiple_correct").unwrap(),
            RestoreDefaultMetricOutcome::Inserted
        );
        transaction.commit().unwrap();
        assert_eq!(
            load_custom_metrics(&connection, "bank-1", false)
                .unwrap()
                .iter()
                .filter(|item| item.system_key.as_deref() == Some("multiple_correct"))
                .count(),
            1
        );
    }
}
