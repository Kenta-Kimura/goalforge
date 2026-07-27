use crate::custom_metrics::{
    validate_definition, validate_population, AttemptField, AttemptPredicate, AttemptScope,
    ComparisonOperator, CountComparison, CountOperator, MetricClause, MetricDefinition,
    PopulationClause, PopulationDefinition, ProblemScope,
};
use chrono::{DateTime, FixedOffset};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use thiserror::Error;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Problem {
    pub id: String,
    pub review_status: ProblemReviewStatus,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProblemReviewStatus {
    Active,
    Completed,
    Paused,
    Excluded,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ProblemAttempt {
    pub id: String,
    pub problem_id: String,
    pub round_id: String,
    pub round_number: Option<u32>,
    pub answered_at: Option<String>,
    pub attempt_number: u32,
    pub earned_score: f64,
    pub max_score: f64,
    pub confidence: Option<AttemptConfidence>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AttemptConfidence {
    High,
    Medium,
    Low,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MetricEvaluationResult {
    pub matched_problem_ids: HashSet<String>,
    pub matched_count: usize,
    pub population_problem_ids: HashSet<String>,
    pub population_count: usize,
}

#[derive(Debug, Error, PartialEq)]
pub enum MetricEvaluationError {
    #[error("Metric DSLが不正です: {0}")]
    InvalidMetricDefinition(String),
    #[error("Population DSLが不正です: {0}")]
    InvalidPopulationDefinition(String),
    #[error("Problem IDが重複しています: {0}")]
    DuplicateProblemId(String),
    #[error("存在しないProblemを参照するAttemptです: {attempt_id} -> {problem_id}")]
    UnknownAttemptProblem {
        attempt_id: String,
        problem_id: String,
    },
    #[error("Problem内でattempt_numberが重複しています: {problem_id} #{attempt_number}")]
    DuplicateAttemptNumber {
        problem_id: String,
        attempt_number: u32,
    },
    #[error("Attemptの得点が不正です: {0}")]
    InvalidScore(String),
    #[error("Attemptのanswered_atがRFC 3339ではありません: {0}")]
    InvalidAnsweredAt(String),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ScoreResult {
    Correct,
    Partial,
    Incorrect,
}

pub fn evaluate_metric(
    problems: &[Problem],
    attempts: &[ProblemAttempt],
    metric: &MetricDefinition,
    population: &PopulationDefinition,
) -> Result<MetricEvaluationResult, MetricEvaluationError> {
    validate_definition(metric)
        .map_err(|error| MetricEvaluationError::InvalidMetricDefinition(error.to_string()))?;
    validate_population(population)
        .map_err(|error| MetricEvaluationError::InvalidPopulationDefinition(error.to_string()))?;

    let problem_map = validated_problem_map(problems)?;
    let attempts_by_problem = group_attempts(attempts, &problem_map)?;
    let population_problem_ids = problems
        .iter()
        .filter(|problem| matches_population(problem, population))
        .map(|problem| problem.id.clone())
        .collect::<HashSet<_>>();

    let mut matched_problem_ids = HashSet::new();
    for problem_id in &population_problem_ids {
        let problem_attempts = attempts_by_problem
            .get(problem_id.as_str())
            .map(Vec::as_slice)
            .unwrap_or(&[]);
        if matches_metric(problem_attempts, metric)? {
            matched_problem_ids.insert(problem_id.clone());
        }
    }

    Ok(MetricEvaluationResult {
        matched_count: matched_problem_ids.len(),
        population_count: population_problem_ids.len(),
        matched_problem_ids,
        population_problem_ids,
    })
}

fn validated_problem_map(
    problems: &[Problem],
) -> Result<HashMap<&str, &Problem>, MetricEvaluationError> {
    let mut problem_map = HashMap::new();
    for problem in problems {
        if problem_map.insert(problem.id.as_str(), problem).is_some() {
            return Err(MetricEvaluationError::DuplicateProblemId(
                problem.id.clone(),
            ));
        }
    }
    Ok(problem_map)
}

fn group_attempts<'a>(
    attempts: &'a [ProblemAttempt],
    problem_map: &HashMap<&str, &Problem>,
) -> Result<HashMap<&'a str, Vec<&'a ProblemAttempt>>, MetricEvaluationError> {
    let mut grouped: HashMap<&str, Vec<&ProblemAttempt>> = HashMap::new();
    let mut numbers: HashMap<&str, HashSet<u32>> = HashMap::new();
    for attempt in attempts {
        if !problem_map.contains_key(attempt.problem_id.as_str()) {
            return Err(MetricEvaluationError::UnknownAttemptProblem {
                attempt_id: attempt.id.clone(),
                problem_id: attempt.problem_id.clone(),
            });
        }
        if !numbers
            .entry(attempt.problem_id.as_str())
            .or_default()
            .insert(attempt.attempt_number)
        {
            return Err(MetricEvaluationError::DuplicateAttemptNumber {
                problem_id: attempt.problem_id.clone(),
                attempt_number: attempt.attempt_number,
            });
        }
        derive_score_result(attempt)?;
        grouped
            .entry(attempt.problem_id.as_str())
            .or_default()
            .push(attempt);
    }
    Ok(grouped)
}

fn matches_population(problem: &Problem, population: &PopulationDefinition) -> bool {
    population.clauses.iter().all(|clause| match clause {
        PopulationClause::ProblemScope {
            scope: ProblemScope::NonExcluded,
        } => problem.review_status != ProblemReviewStatus::Excluded,
    })
}

fn matches_metric(
    attempts: &[&ProblemAttempt],
    metric: &MetricDefinition,
) -> Result<bool, MetricEvaluationError> {
    for clause in &metric.clauses {
        let MetricClause::AttemptCount {
            attempt_scope,
            r#where,
            count,
        } = clause;
        let scoped = scoped_attempts(attempts, *attempt_scope);
        let mut matched_count = 0_u32;
        for attempt in scoped {
            let mut matches = true;
            for predicate in &r#where.clauses {
                if !matches_predicate(attempt, predicate)? {
                    matches = false;
                    break;
                }
            }
            if matches {
                matched_count += 1;
            }
        }
        if !matches_count(matched_count, count) {
            return Ok(false);
        }
    }
    Ok(true)
}

fn scoped_attempts<'a>(
    attempts: &'a [&'a ProblemAttempt],
    scope: AttemptScope,
) -> Vec<&'a ProblemAttempt> {
    let latest_number = attempts.iter().map(|attempt| attempt.attempt_number).max();
    match (scope, latest_number) {
        (AttemptScope::All, _) => attempts.to_vec(),
        (AttemptScope::Latest, Some(latest)) => attempts
            .iter()
            .copied()
            .filter(|attempt| attempt.attempt_number == latest)
            .collect(),
        (AttemptScope::ExceptLatest, Some(latest)) => attempts
            .iter()
            .copied()
            .filter(|attempt| attempt.attempt_number != latest)
            .collect(),
        (_, None) => vec![],
    }
}

fn matches_count(actual: u32, comparison: &CountComparison) -> bool {
    match comparison.operator {
        CountOperator::Eq => actual == comparison.value,
        CountOperator::Gte => actual >= comparison.value,
        CountOperator::Lte => actual <= comparison.value,
    }
}

fn matches_predicate(
    attempt: &ProblemAttempt,
    predicate: &AttemptPredicate,
) -> Result<bool, MetricEvaluationError> {
    let AttemptPredicate::Field {
        field,
        operator,
        value,
    } = predicate;
    if *operator == ComparisonOperator::IsNull {
        return Ok(field_is_null(attempt, *field));
    }
    if *operator == ComparisonOperator::IsNotNull {
        return Ok(!field_is_null(attempt, *field));
    }
    let value = value
        .as_ref()
        .expect("validated Metric DSL always provides comparison values");

    match field {
        AttemptField::Result => compare_string(
            score_result_value(derive_score_result(attempt)?),
            *operator,
            value,
        ),
        AttemptField::Confidence => {
            compare_optional_string(attempt.confidence.map(confidence_value), *operator, value)
        }
        AttemptField::AttemptNumber => {
            compare_number(attempt.attempt_number as u64, *operator, value)
        }
        AttemptField::RoundId => compare_string(&attempt.round_id, *operator, value),
        AttemptField::RoundNumber => {
            compare_optional_number(attempt.round_number.map(u64::from), *operator, value)
        }
        AttemptField::AnsweredAt => {
            compare_optional_timestamp(attempt.answered_at.as_deref(), *operator, value)
        }
    }
}

fn field_is_null(attempt: &ProblemAttempt, field: AttemptField) -> bool {
    match field {
        AttemptField::Confidence => attempt.confidence.is_none(),
        AttemptField::RoundNumber => attempt.round_number.is_none(),
        AttemptField::AnsweredAt => attempt.answered_at.is_none(),
        AttemptField::Result | AttemptField::AttemptNumber | AttemptField::RoundId => false,
    }
}

fn compare_string(
    actual: &str,
    operator: ComparisonOperator,
    value: &Value,
) -> Result<bool, MetricEvaluationError> {
    let expected = value.as_str().expect("validated string comparison value");
    Ok(match operator {
        ComparisonOperator::Eq => actual == expected,
        ComparisonOperator::Neq => actual != expected,
        _ => unreachable!("validated operator for string field"),
    })
}

fn compare_optional_string(
    actual: Option<&str>,
    operator: ComparisonOperator,
    value: &Value,
) -> Result<bool, MetricEvaluationError> {
    let expected = value.as_str().expect("validated string comparison value");
    Ok(match operator {
        ComparisonOperator::Eq => actual == Some(expected),
        ComparisonOperator::Neq => actual != Some(expected),
        _ => unreachable!("validated operator for string field"),
    })
}

fn compare_number(
    actual: u64,
    operator: ComparisonOperator,
    value: &Value,
) -> Result<bool, MetricEvaluationError> {
    Ok(match operator {
        ComparisonOperator::Eq => actual == value.as_u64().unwrap(),
        ComparisonOperator::Neq => actual != value.as_u64().unwrap(),
        ComparisonOperator::Gte => actual >= value.as_u64().unwrap(),
        ComparisonOperator::Lte => actual <= value.as_u64().unwrap(),
        ComparisonOperator::Between => {
            let range = value.as_array().unwrap();
            actual >= range[0].as_u64().unwrap() && actual <= range[1].as_u64().unwrap()
        }
        _ => unreachable!("validated operator for number field"),
    })
}

fn compare_optional_number(
    actual: Option<u64>,
    operator: ComparisonOperator,
    value: &Value,
) -> Result<bool, MetricEvaluationError> {
    let Some(actual) = actual else {
        return Ok(operator == ComparisonOperator::Neq);
    };
    compare_number(actual, operator, value)
}

fn compare_optional_timestamp(
    actual: Option<&str>,
    operator: ComparisonOperator,
    value: &Value,
) -> Result<bool, MetricEvaluationError> {
    let Some(actual) = actual else {
        return Ok(operator == ComparisonOperator::Neq);
    };
    let actual = parse_timestamp(actual)?;
    Ok(match operator {
        ComparisonOperator::Eq => actual == parse_timestamp(value.as_str().unwrap())?,
        ComparisonOperator::Neq => actual != parse_timestamp(value.as_str().unwrap())?,
        ComparisonOperator::Gte => actual >= parse_timestamp(value.as_str().unwrap())?,
        ComparisonOperator::Lte => actual <= parse_timestamp(value.as_str().unwrap())?,
        ComparisonOperator::Between => {
            let range = value.as_array().unwrap();
            actual >= parse_timestamp(range[0].as_str().unwrap())?
                && actual <= parse_timestamp(range[1].as_str().unwrap())?
        }
        _ => unreachable!("validated operator for timestamp field"),
    })
}

fn parse_timestamp(value: &str) -> Result<DateTime<FixedOffset>, MetricEvaluationError> {
    DateTime::parse_from_rfc3339(value)
        .map_err(|_| MetricEvaluationError::InvalidAnsweredAt(value.into()))
}

fn derive_score_result(attempt: &ProblemAttempt) -> Result<ScoreResult, MetricEvaluationError> {
    if !attempt.earned_score.is_finite()
        || !attempt.max_score.is_finite()
        || attempt.max_score <= 0.0
        || attempt.earned_score < 0.0
        || attempt.earned_score > attempt.max_score
    {
        return Err(MetricEvaluationError::InvalidScore(attempt.id.clone()));
    }
    if attempt.earned_score >= attempt.max_score {
        Ok(ScoreResult::Correct)
    } else if attempt.earned_score == 0.0 {
        Ok(ScoreResult::Incorrect)
    } else {
        Ok(ScoreResult::Partial)
    }
}

fn score_result_value(result: ScoreResult) -> &'static str {
    match result {
        ScoreResult::Correct => "correct",
        ScoreResult::Partial => "partial",
        ScoreResult::Incorrect => "incorrect",
    }
}

fn confidence_value(confidence: AttemptConfidence) -> &'static str {
    match confidence {
        AttemptConfidence::High => "high",
        AttemptConfidence::Medium => "medium",
        AttemptConfidence::Low => "low",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::custom_metrics::{
        default_metric_templates, default_population_definition, AttemptFilterGroup,
        BooleanOperator, CountComparison, MetricClause,
    };
    use serde_json::json;

    fn problem(id: &str, review_status: ProblemReviewStatus) -> Problem {
        Problem {
            id: id.into(),
            review_status,
        }
    }

    fn attempt(
        id: &str,
        problem_id: &str,
        attempt_number: u32,
        earned_score: f64,
        max_score: f64,
        confidence: Option<AttemptConfidence>,
    ) -> ProblemAttempt {
        ProblemAttempt {
            id: id.into(),
            problem_id: problem_id.into(),
            round_id: format!("round-{attempt_number}"),
            round_number: Some(attempt_number),
            answered_at: Some(format!("2026-01-{attempt_number:02}T00:00:00Z")),
            attempt_number,
            earned_score,
            max_score,
            confidence,
        }
    }

    fn evaluate_default(
        template_index: usize,
        problems: &[Problem],
        attempts: &[ProblemAttempt],
    ) -> MetricEvaluationResult {
        evaluate_metric(
            problems,
            attempts,
            &default_metric_templates()[template_index].definition,
            &default_population_definition(),
        )
        .unwrap()
    }

    fn metric(
        scope: AttemptScope,
        predicates: Vec<AttemptPredicate>,
        count_operator: CountOperator,
        count: u32,
    ) -> MetricDefinition {
        MetricDefinition {
            version: 1,
            operator: BooleanOperator::And,
            clauses: vec![MetricClause::AttemptCount {
                attempt_scope: scope,
                r#where: AttemptFilterGroup {
                    operator: BooleanOperator::And,
                    clauses: predicates,
                },
                count: CountComparison {
                    operator: count_operator,
                    value: count,
                },
            }],
        }
    }

    fn predicate(
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
    fn default_metrics_cover_no_attempt_one_correct_and_two_correct() {
        let problems = [
            problem("none", ProblemReviewStatus::Active),
            problem("one", ProblemReviewStatus::Active),
            problem("two", ProblemReviewStatus::Active),
        ];
        let attempts = [
            attempt("one-1", "one", 1, 1.0, 1.0, None),
            attempt("two-1", "two", 1, 1.0, 1.0, None),
            attempt("two-2", "two", 2, 1.0, 1.0, None),
        ];
        assert_eq!(
            evaluate_default(0, &problems, &attempts).matched_problem_ids,
            HashSet::from(["one".into(), "two".into()])
        );
        assert_eq!(
            evaluate_default(2, &problems, &attempts).matched_problem_ids,
            HashSet::from(["two".into()])
        );
    }

    #[test]
    fn incorrect_and_partial_attempts_do_not_count_as_correct() {
        let problems = [
            problem("incorrect", ProblemReviewStatus::Active),
            problem("partial", ProblemReviewStatus::Active),
        ];
        let attempts = [
            attempt("incorrect-1", "incorrect", 1, 0.0, 1.0, None),
            attempt("partial-1", "partial", 1, 0.5, 1.0, None),
        ];
        assert!(evaluate_default(0, &problems, &attempts)
            .matched_problem_ids
            .is_empty());
    }

    #[test]
    fn confident_correct_requires_both_conditions_on_same_attempt() {
        let problems = [
            problem("same", ProblemReviewStatus::Active),
            problem("separate", ProblemReviewStatus::Active),
        ];
        let attempts = [
            attempt("same-1", "same", 1, 1.0, 1.0, Some(AttemptConfidence::High)),
            attempt(
                "separate-1",
                "separate",
                1,
                1.0,
                1.0,
                Some(AttemptConfidence::Low),
            ),
            attempt(
                "separate-2",
                "separate",
                2,
                0.0,
                1.0,
                Some(AttemptConfidence::High),
            ),
        ];
        assert_eq!(
            evaluate_default(1, &problems, &attempts).matched_problem_ids,
            HashSet::from(["same".into()])
        );
    }

    #[test]
    fn latest_and_except_latest_use_attempt_number_not_answered_at() {
        let problems = [problem("p1", ProblemReviewStatus::Active)];
        let mut earlier_number = attempt("a1", "p1", 1, 1.0, 1.0, None);
        earlier_number.answered_at = Some("2026-12-31T00:00:00Z".into());
        let mut latest_number = attempt("a2", "p1", 2, 0.0, 1.0, None);
        latest_number.answered_at = Some("2026-01-01T00:00:00Z".into());
        let attempts = [earlier_number, latest_number];
        let correct = vec![predicate(
            AttemptField::Result,
            ComparisonOperator::Eq,
            Some(json!("correct")),
        )];

        assert!(evaluate_metric(
            &problems,
            &attempts,
            &metric(AttemptScope::Latest, correct.clone(), CountOperator::Gte, 1),
            &default_population_definition(),
        )
        .unwrap()
        .matched_problem_ids
        .is_empty());
        assert_eq!(
            evaluate_metric(
                &problems,
                &attempts,
                &metric(AttemptScope::ExceptLatest, correct, CountOperator::Gte, 1),
                &default_population_definition(),
            )
            .unwrap()
            .matched_count,
            1
        );
    }

    #[test]
    fn null_answered_at_and_and_predicates_are_supported() {
        let problems = [problem("p1", ProblemReviewStatus::Active)];
        let mut target = attempt("a1", "p1", 1, 1.0, 1.0, Some(AttemptConfidence::High));
        target.answered_at = None;
        let definition = metric(
            AttemptScope::All,
            vec![
                predicate(
                    AttemptField::Result,
                    ComparisonOperator::Eq,
                    Some(json!("correct")),
                ),
                predicate(
                    AttemptField::Confidence,
                    ComparisonOperator::Eq,
                    Some(json!("high")),
                ),
                predicate(AttemptField::AnsweredAt, ComparisonOperator::IsNull, None),
            ],
            CountOperator::Eq,
            1,
        );
        assert_eq!(
            evaluate_metric(
                &problems,
                &[target],
                &definition,
                &default_population_definition()
            )
            .unwrap()
            .matched_count,
            1
        );
    }

    #[test]
    fn all_fields_and_comparison_operators_are_supported() {
        let problems = [problem("p1", ProblemReviewStatus::Active)];
        let target = attempt("a1", "p1", 2, 1.0, 1.0, Some(AttemptConfidence::Medium));
        let definition = metric(
            AttemptScope::All,
            vec![
                predicate(
                    AttemptField::AttemptNumber,
                    ComparisonOperator::Between,
                    Some(json!([1, 3])),
                ),
                predicate(
                    AttemptField::RoundId,
                    ComparisonOperator::Neq,
                    Some(json!("round-x")),
                ),
                predicate(
                    AttemptField::RoundNumber,
                    ComparisonOperator::Gte,
                    Some(json!(2)),
                ),
                predicate(
                    AttemptField::AnsweredAt,
                    ComparisonOperator::Lte,
                    Some(json!("2026-01-31T00:00:00Z")),
                ),
                predicate(
                    AttemptField::AnsweredAt,
                    ComparisonOperator::IsNotNull,
                    None,
                ),
            ],
            CountOperator::Lte,
            1,
        );
        assert_eq!(
            evaluate_metric(
                &problems,
                &[target],
                &definition,
                &default_population_definition()
            )
            .unwrap()
            .matched_count,
            1
        );
    }

    #[test]
    fn population_excludes_excluded_problems_and_reports_counts() {
        let problems = [
            problem("active", ProblemReviewStatus::Active),
            problem("completed", ProblemReviewStatus::Completed),
            problem("paused", ProblemReviewStatus::Paused),
            problem("excluded", ProblemReviewStatus::Excluded),
        ];
        let attempts = [
            attempt("active-1", "active", 1, 1.0, 1.0, None),
            attempt("excluded-1", "excluded", 1, 1.0, 1.0, None),
        ];
        let result = evaluate_default(0, &problems, &attempts);
        assert_eq!(result.population_count, 3);
        assert_eq!(
            result.population_problem_ids,
            HashSet::from(["active".into(), "completed".into(), "paused".into()])
        );
        assert_eq!(result.matched_problem_ids, HashSet::from(["active".into()]));
        assert_eq!(result.matched_count, 1);
    }

    #[test]
    fn outer_metric_clauses_are_combined_with_and() {
        let problems = [problem("both", ProblemReviewStatus::Active)];
        let attempts = [
            attempt("correct", "both", 1, 1.0, 1.0, None),
            attempt("incorrect", "both", 2, 0.0, 1.0, None),
        ];
        let definition = MetricDefinition {
            version: 1,
            operator: BooleanOperator::And,
            clauses: vec![
                MetricClause::AttemptCount {
                    attempt_scope: AttemptScope::All,
                    r#where: AttemptFilterGroup {
                        operator: BooleanOperator::And,
                        clauses: vec![predicate(
                            AttemptField::Result,
                            ComparisonOperator::Eq,
                            Some(json!("correct")),
                        )],
                    },
                    count: CountComparison {
                        operator: CountOperator::Gte,
                        value: 1,
                    },
                },
                MetricClause::AttemptCount {
                    attempt_scope: AttemptScope::All,
                    r#where: AttemptFilterGroup {
                        operator: BooleanOperator::And,
                        clauses: vec![predicate(
                            AttemptField::Result,
                            ComparisonOperator::Eq,
                            Some(json!("incorrect")),
                        )],
                    },
                    count: CountComparison {
                        operator: CountOperator::Gte,
                        value: 1,
                    },
                },
            ],
        };
        assert_eq!(
            evaluate_metric(
                &problems,
                &attempts,
                &definition,
                &default_population_definition()
            )
            .unwrap()
            .matched_count,
            1
        );
    }

    #[test]
    fn invalid_dsl_and_input_invariants_return_errors() {
        let problems = [problem("p1", ProblemReviewStatus::Active)];
        let mut invalid_version = default_metric_templates()[0].definition.clone();
        invalid_version.version = 2;
        assert!(matches!(
            evaluate_metric(
                &problems,
                &[],
                &invalid_version,
                &default_population_definition()
            ),
            Err(MetricEvaluationError::InvalidMetricDefinition(_))
        ));

        let mut invalid_population = default_population_definition();
        invalid_population.version = 2;
        assert!(matches!(
            evaluate_metric(
                &problems,
                &[],
                &default_metric_templates()[0].definition,
                &invalid_population
            ),
            Err(MetricEvaluationError::InvalidPopulationDefinition(_))
        ));

        let attempts = [
            attempt("a1", "p1", 1, 1.0, 1.0, None),
            attempt("a2", "p1", 1, 0.0, 1.0, None),
        ];
        assert!(matches!(
            evaluate_metric(
                &problems,
                &attempts,
                &default_metric_templates()[0].definition,
                &default_population_definition()
            ),
            Err(MetricEvaluationError::DuplicateAttemptNumber { .. })
        ));
    }
}
