//! Finite, human-reviewed browser actions. No arbitrary JavaScript or shell.
use super::{CheckCriterion, CheckPlan, CheckScope};
use crate::{CancellationToken, ExecutionOutcome, ExecutionTermination};
use anyhow::{ensure, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::BTreeSet,
    time::{Duration, Instant},
};
#[cfg(test)]
mod tests;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BrowserCheck {
    pub ready_selector: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub viewport: Option<CheckViewport>,
    pub steps: Vec<BrowserStep>,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CheckViewport {
    pub width: u32,
    pub height: u32,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(
    tag = "action",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum BrowserStep {
    Fill {
        selector: String,
        text: String,
    },
    Click {
        selector: String,
    },
    Observe {
        criterion_id: String,
        reads: Vec<BrowserRead>,
        wait_ms: u64,
    },
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BrowserRead {
    pub key: String,
    pub selector: String,
    pub kind: BrowserReadKind,
}
#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum BrowserReadKind {
    Text,
    Texts,
    Count,
    Height,
}

impl BrowserReadKind {
    fn accepts(self, value: &Value) -> bool {
        match self {
            Self::Text => value.as_str().is_some_and(|v| v.len() <= 2000),
            Self::Texts => value.as_array().is_some_and(|v| {
                v.len() <= 20
                    && v.iter()
                        .all(|s| s.as_str().is_some_and(|s| s.len() <= 2000))
            }),
            Self::Count => value.as_u64().is_some_and(|n| n <= 1000),
            Self::Height => value
                .as_f64()
                .is_some_and(|n| n.is_finite() && n > 0.0 && n <= 100_000.0),
        }
    }
}

impl BrowserCheck {
    pub fn validate(&self, criteria: &[CheckCriterion]) -> Result<()> {
        if let Some(viewport) = &self.viewport {
            ensure!(
                (320..=2560).contains(&viewport.width) && (320..=1600).contains(&viewport.height),
                "Check viewport must be 320–2560 by 320–1600 CSS pixels"
            );
        }
        ensure!(
            !self.steps.is_empty() && self.steps.len() <= 16,
            "Provide 1–16 browser steps"
        );
        ensure!(
            criteria.iter().all(|c| c.scope == CheckScope::Browser),
            "Native browser actions require browser-scoped requirements"
        );
        let selector = |s: &str| -> Result<()> {
            ensure!(
                !s.trim().is_empty() && s.len() <= 512,
                "Provide a bounded CSS selector"
            );
            Ok(())
        };
        let mut observed = BTreeSet::new();
        selector(&self.ready_selector)?;
        for step in &self.steps {
            match step {
                BrowserStep::Fill { selector: s, text } => {
                    selector(s)?;
                    ensure!(text.len() <= 2000, "Browser input is too long");
                }
                BrowserStep::Click { selector: s } => selector(s)?,
                BrowserStep::Observe {
                    criterion_id,
                    reads,
                    wait_ms,
                } => {
                    let criterion = criteria
                        .iter()
                        .find(|c| &c.id == criterion_id)
                        .context("Unknown browser observation key")?;
                    ensure!(
                        observed.insert(criterion_id),
                        "Duplicate browser observation"
                    );
                    ensure!(
                        !reads.is_empty() && reads.len() <= 4 && *wait_ms <= 3000,
                        "Use 1–4 reads and at most 3000 ms of observation time"
                    );
                    let mut keys = BTreeSet::new();
                    for read in reads {
                        selector(&read.selector)?;
                        ensure!(
                            !matches!(read.kind, BrowserReadKind::Height)
                                || self.viewport.is_some(),
                            "Height observations require an explicit reviewed viewport"
                        );
                        ensure!(
                            !read.key.is_empty()
                                && read.key.len() <= 40
                                && read
                                    .key
                                    .bytes()
                                    .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_'),
                            "Invalid browser read key"
                        );
                        ensure!(keys.insert(read.key.clone()), "Duplicate browser read key");
                    }
                    let expected = criterion.expected.as_object().context(
                        "Browser expected values must be an object matching the read keys",
                    )?;
                    ensure!(
                        expected.len() == keys.len() && expected.keys().all(|k| keys.contains(k)),
                        "Expected keys must match the reviewed browser reads"
                    );
                    for read in reads {
                        let value = &expected[&read.key];
                        ensure!(
                            read.kind.accepts(value),
                            "Expected browser values must match their bounded text/count/height read type"
                        );
                    }
                }
            }
        }
        ensure!(
            observed.len() == criteria.len(),
            "Each browser requirement needs exactly one observation"
        );
        ensure!(
            serde_json::to_vec(self)?.len() <= 12000,
            "Browser plan is too large"
        );
        Ok(())
    }
}

fn check_viewport(value: &Value, viewport: &Option<CheckViewport>) -> Result<()> {
    if let Some(viewport) = viewport {
        ensure!(
            value["viewport"]["width"].as_u64() == Some(viewport.width as u64)
                && value["viewport"]["height"].as_u64() == Some(viewport.height as u64),
            "Browser viewport does not match the approved CSS dimensions"
        );
    }
    Ok(())
}

pub trait BrowserDriver {
    fn call(&mut self, method: &str, args: Value) -> Result<Value>;
    fn pause(&mut self, duration: Duration) {
        std::thread::sleep(duration);
    }
}

fn check_origin(value: &Value, origin: &str) -> Result<()> {
    let url = url::Url::parse(
        value["url"]
            .as_str()
            .context("Browser returned no page URL")?,
    )?;
    ensure!(
        url.origin().ascii_serialization() == origin,
        "Browser left the approved origin"
    );
    ensure!(
        value["readyState"] == "complete",
        "Browser page is not ready"
    );
    Ok(())
}

pub fn run(
    plan: &CheckPlan,
    driver: &mut impl BrowserDriver,
    cancel: CancellationToken,
) -> Result<ExecutionOutcome> {
    let browser = plan
        .draft
        .browser
        .as_ref()
        .context("Missing browser action")?;
    browser.validate(&plan.draft.criteria)?;
    let origin = url::Url::parse(&plan.draft.preview_url)?
        .origin()
        .ascii_serialization();
    let started = Instant::now();
    let mut observations = Vec::new();
    let mut transcript = Vec::new();
    let mut termination = ExecutionTermination::Exited { code: Some(0) };
    let mut stderr = String::new();
    for (index, step) in browser.steps.iter().enumerate() {
        let result = (|| -> Result<()> {
            ensure!(!cancel.is_cancelled(), "Browser check was cancelled");
            ensure!(
                started.elapsed() < Duration::from_secs(60),
                "Browser check timed out"
            );
            let status = driver.call("status", json!({}))?;
            check_origin(&status, &origin)?;
            check_viewport(&status, &browser.viewport)?;
            let ready =
                driver.call("find", json!({"selector":browser.ready_selector,"limit":2}))?;
            ensure!(ready["results"].as_array().is_some_and(|r|r.len()==1) && ready["hasMore"]==false,"Expected browser page is unavailable; its ready selector must match one visible element");
            match step {
                BrowserStep::Fill { selector, .. } | BrowserStep::Click { selector } => {
                    let found = driver.call("find", json!({"selector":selector,"limit":2}))?;
                    let matches = found["results"]
                        .as_array()
                        .context("Browser did not return matching elements")?;
                    ensure!(
                        matches.len() == 1 && found["hasMore"] == false,
                        "Browser action needs exactly one visible element"
                    );
                    let reference = matches[0]["ref"]
                        .as_str()
                        .context("Browser target is unavailable")?;
                    ensure!(
                        !cancel.is_cancelled(),
                        "Browser check was cancelled before the action"
                    );
                    ensure!(
                        started.elapsed() < Duration::from_secs(60),
                        "Browser check timed out before the action"
                    );
                    let (method, args) = match step {
                        BrowserStep::Fill { text, .. } => {
                            ("formInput", json!({"ref":reference,"value":text}))
                        }
                        _ => ("click", json!({"ref":reference})),
                    };
                    driver.call(method, args)?;
                    transcript
                        .push(json!({"step":index+1,"action":step,"target":matches[0]["name"]}));
                }
                BrowserStep::Observe {
                    criterion_id,
                    reads,
                    wait_ms,
                } => {
                    let expected = &plan
                        .draft
                        .criteria
                        .iter()
                        .find(|c| &c.id == criterion_id)
                        .unwrap()
                        .expected;
                    let until = Instant::now() + Duration::from_millis(*wait_ms);
                    let (actual, viewport) = loop {
                        ensure!(!cancel.is_cancelled(), "Browser check was cancelled");
                        ensure!(
                            started.elapsed() < Duration::from_secs(60),
                            "Browser check timed out"
                        );
                        let result = driver.call(
                            "checkRead",
                            json!({"reads":reads,"readySelector":browser.ready_selector}),
                        )?;
                        check_origin(&result, &origin)?;
                        check_viewport(&result, &browser.viewport)?;
                        let actual = result
                            .get("values")
                            .context("Browser returned no observed values")?;
                        ensure!(
                            actual.as_object().is_some_and(|v| v.len() == reads.len()
                                && reads.iter().all(|r| v
                                    .get(&r.key)
                                    .is_some_and(|value| r.kind.accepts(value)))),
                            "Browser returned incomplete or invalid observed values"
                        );
                        ensure!(
                            serde_json::to_vec(actual)?.len() <= 4096,
                            "Browser evidence is too large"
                        );
                        if actual == expected || Instant::now() >= until {
                            break (actual.clone(), result.get("viewport").cloned());
                        }
                        driver.pause(Duration::from_millis(100));
                    };
                    let evidence =
                        json!({"steps":transcript,"reads":reads,"observed":actual,"origin":origin,"viewport":viewport})
                            .to_string();
                    ensure!(
                        evidence.len() <= 8192,
                        "Browser evidence exceeded its bound"
                    );
                    observations.push(json!({"criterionId":criterion_id,"scope":"browser","actual":actual,"evidence":evidence}));
                    transcript.clear();
                }
            }
            Ok(())
        })();
        if let Err(error) = result {
            stderr = format!(
                "Browser step {} stopped: {error}. Remaining requirements were not checked.",
                index + 1
            );
            break;
        }
    }
    if cancel.is_cancelled() {
        termination = ExecutionTermination::Cancelled;
    } else if started.elapsed() >= Duration::from_secs(60) {
        termination = ExecutionTermination::TimedOut;
    }
    let stdout =
        json!({"version":2,"previewUrl":plan.draft.preview_url,"observations":observations})
            .to_string();
    let stdout_truncated = stdout.chars().count() > 32768;
    let stderr_truncated = stderr.chars().count() > 16384;
    Ok(ExecutionOutcome {
        termination,
        stdout: stdout.chars().take(32768).collect(),
        stderr: stderr.chars().take(16384).collect(),
        stdout_truncated,
        stderr_truncated,
        duration_ms: started.elapsed().as_millis() as u64,
    })
}
