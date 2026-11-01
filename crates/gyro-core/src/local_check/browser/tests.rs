//! State-machine fixtures only: these do not launch a native browser.
use super::*;
use crate::local_check::{report_from_output, CheckStatus};
fn plan() -> CheckPlan {
    serde_json::from_value(json!({
        "id":uuid::Uuid::new_v4(),"createdAt":"2026-10-30T00:00:00Z","workspaceRevision":1,
        "draft":{"sessionId":uuid::Uuid::new_v4(),"previewUrl":"http://127.0.0.1:4317","command":"","dataChanges":"Synthetic fixture only","files":["todo.mjs"],
        "criteria":[{"id":"add-item","requirement":"Add visibly","scope":"browser","expected":{"texts":["Gyro Check item"],"items":1}},{"id":"reject-empty","requirement":"Reject blank visibly","scope":"browser","expected":{"error":"A title is required","items":1}}],
        "browser":{"readySelector":"form","steps":[
            {"action":"fill","selector":"input","text":"Gyro Check item"},
            {"action":"click","selector":"button"},
            {"action":"observe","criterionId":"add-item","waitMs":0,"reads":[{"key":"texts","selector":"li","kind":"texts"},{"key":"items","selector":"li","kind":"count"}]},
            {"action":"fill","selector":"input","text":"   "},
            {"action":"click","selector":"button"},
            {"action":"observe","criterionId":"reject-empty","waitMs":0,"reads":[{"key":"error","selector":"#error","kind":"text"},{"key":"items","selector":"li","kind":"count"}]}
        ]}},"snapshot":{"workspace":"/tmp","gitHead":null,"files":[]}
    })).unwrap()
}
struct Fixture {
    mode: &'static str,
    input: String,
    items: Vec<String>,
    error: String,
    clicks: usize,
    cancel: Option<CancellationToken>,
}
impl Fixture {
    fn new(mode: &'static str) -> Self {
        Self {
            mode,
            input: String::new(),
            items: vec![],
            error: String::new(),
            clicks: 0,
            cancel: None,
        }
    }
}
impl BrowserDriver for Fixture {
    fn call(&mut self, method: &str, args: Value) -> Result<Value> {
        let state = json!({"url":if self.mode=="off-origin" {"https://outside.test"}else{"http://127.0.0.1:4317/"},"readyState":"complete"});
        match method {
            "status" => Ok(state),
            "find" => Ok(if self.mode == "missing-root" {
                json!({"results":[],"hasMore":false})
            } else if self.mode == "ambiguous" {
                json!({"results":[{"ref":"1"},{"ref":"2"}],"hasMore":false})
            } else {
                json!({"results":[{"ref":"1","name":"Synthetic element"}],"hasMore":false})
            }),
            "formInput" => {
                if self.mode == "later-unavailable" && self.clicks > 0 {
                    anyhow::bail!("synthetic page unavailable");
                }
                self.input = args["value"].as_str().unwrap().into();
                Ok(json!({"ok":true}))
            }
            "click" => {
                self.clicks += 1;
                if self.mode == "lost-click-ack" {
                    anyhow::bail!("click completed but its acknowledgement was lost");
                }
                if self.mode != "broken-form" {
                    if !self.input.trim().is_empty() || self.mode == "broken" {
                        self.items.push(self.input.trim().into());
                        self.error.clear();
                    } else {
                        self.error = "A title is required".into();
                    }
                }
                if self.clicks == 2 {
                    if let Some(token) = &self.cancel {
                        token.cancel();
                    }
                }
                Ok(json!({"ok":true}))
            }
            "checkRead" => {
                let mut values = serde_json::Map::new();
                for read in args["reads"].as_array().unwrap() {
                    let value = match read["kind"].as_str().unwrap() {
                        "count" => json!(self.items.len()),
                        "texts" => json!(self.items),
                        _ => json!(self.error),
                    };
                    values.insert(read["key"].as_str().unwrap().into(), value);
                }
                let mut result = state;
                result["values"] = Value::Object(values);
                Ok(result)
            }
            _ => anyhow::bail!("Unsupported method"),
        }
    }
}
#[test]
fn fixture_browser_observations_distinguish_working_broken_and_missing_form_actions() {
    for (mode, expected) in [
        ("working", [CheckStatus::Passed, CheckStatus::Passed]),
        ("broken", [CheckStatus::Passed, CheckStatus::Failed]),
        ("broken-form", [CheckStatus::Failed, CheckStatus::Failed]),
    ] {
        let p = plan();
        p.draft.validate().unwrap();
        let mut driver = Fixture::new(mode);
        let output = run(&p, &mut driver, CancellationToken::default()).unwrap();
        let report = report_from_output(p, output);
        assert_eq!(
            [
                report.results[0].status.clone(),
                report.results[1].status.clone()
            ],
            expected
        );
        assert_eq!(driver.clicks, 2, "No action should be replayed");
        assert!(report
            .results
            .iter()
            .all(|r| r.observed_scope == Some(CheckScope::Browser)));
    }
}
#[test]
fn origin_errors_ambiguous_targets_and_cancellation_never_pass() {
    for mode in ["off-origin", "ambiguous", "cancelled"] {
        let p = plan();
        let mut driver = Fixture::new(mode);
        let token = CancellationToken::default();
        if mode == "cancelled" {
            token.cancel();
        }
        let output = run(&p, &mut driver, token).unwrap();
        let report = report_from_output(p, output);
        assert!(report
            .results
            .iter()
            .all(|r| r.status == CheckStatus::NotChecked));
        assert_eq!(driver.clicks, 0);
    }
    let p = plan();
    let mut uncertain = Fixture::new("lost-click-ack");
    let report = report_from_output(
        p.clone(),
        run(&p, &mut uncertain, CancellationToken::default()).unwrap(),
    );
    assert!(report
        .results
        .iter()
        .all(|r| r.status == CheckStatus::NotChecked));
    assert_eq!(
        uncertain.clicks, 1,
        "An uncertain click must never be replayed"
    );
    let mut driver = Fixture::new("working");
    let token = CancellationToken::default();
    driver.cancel = Some(token.clone());
    let report = report_from_output(p.clone(), run(&p, &mut driver, token).unwrap());
    assert!(report
        .results
        .iter()
        .all(|r| r.status == CheckStatus::NotChecked));
}
#[test]
fn later_unavailable_action_preserves_completed_evidence_without_inventing_the_rest() {
    let p = plan();
    let mut driver = Fixture::new("later-unavailable");
    let report = report_from_output(
        p.clone(),
        run(&p, &mut driver, CancellationToken::default()).unwrap(),
    );
    assert_eq!(report.results[0].status, CheckStatus::Passed);
    assert_eq!(report.results[1].status, CheckStatus::NotChecked);
    assert_eq!(driver.clicks, 1);
    assert!(report
        .output
        .unwrap()
        .stderr
        .contains("synthetic page unavailable"));
}
#[test]
fn invalid_or_mixed_browser_plans_cannot_reach_a_driver_or_command_runner() {
    let p = plan();
    let mut invalid = p.clone();
    invalid.draft.command = "touch should-not-exist".into();
    assert!(invalid.draft.validate().is_err());
    let mut invalid = p.clone();
    invalid.draft.criteria[0].scope = CheckScope::Api;
    assert!(invalid.draft.validate().is_err());
    let mut invalid = p.clone();
    invalid.draft.browser.as_mut().unwrap().steps.pop();
    assert!(invalid.draft.validate().is_err());
    let mut invalid = p.clone();
    invalid.draft.criteria[0].expected = json!({"wrong":true});
    assert!(invalid.draft.validate().is_err());
    assert!(serde_json::from_value::<BrowserCheck>(
        json!({"readySelector":"form","steps":[{"action":"evaluate","javascript":"unapproved()"}]})
    )
    .is_err());
    assert!(crate::local_check::run_check(
        &p,
        std::path::Path::new("/tmp"),
        std::path::Path::new("/tmp/private"),
        CancellationToken::default()
    )
    .is_err());
}

#[test]
fn a_missing_expected_page_cannot_pass_a_zero_count_assertion() {
    let mut p = plan();
    p.draft.criteria.truncate(1);
    p.draft.criteria[0].expected = json!({"texts":[],"items":0});
    p.draft
        .browser
        .as_mut()
        .unwrap()
        .steps
        .retain(|s| matches!(s,BrowserStep::Observe{criterion_id,..} if criterion_id=="add-item"));
    p.draft.validate().unwrap();
    let mut driver = Fixture::new("missing-root");
    let report = report_from_output(
        p.clone(),
        run(&p, &mut driver, CancellationToken::default()).unwrap(),
    );
    assert_eq!(report.results[0].status, CheckStatus::NotChecked);
    assert!(report.results[0].reason.contains("ready selector"));
}

fn height_plan() -> CheckPlan {
    let mut p = plan();
    p.draft.criteria.truncate(1);
    p.draft.criteria[0].expected = json!({"row":59.25});
    p.draft.browser = Some(
        serde_json::from_value(json!({
            "readySelector":"body", "viewport":{"width":1440,"height":1080},
            "steps":[{"action":"observe","criterionId":"add-item","waitMs":0,
                "reads":[{"key":"row","selector":"#row","kind":"height"}]}]
        }))
        .unwrap(),
    );
    p
}

struct GeometryFixture {
    actual: Value,
    viewport: Value,
    change_during_read: bool,
}
impl BrowserDriver for GeometryFixture {
    fn call(&mut self, method: &str, _: Value) -> Result<Value> {
        match method {
            "find" => Ok(json!({"results":[{"ref":"1"}],"hasMore":false})),
            "status" | "checkRead" => Ok(json!({
                "url":"http://127.0.0.1:4317/","readyState":"complete",
                "viewport":if method == "checkRead" && self.change_during_read { json!({"width":390,"height":844}) } else { self.viewport.clone() },
                "values":{"row":self.actual}
            })),
            _ => anyhow::bail!("Geometry must not invoke mutations"),
        }
    }
}

#[test]
fn height_keeps_exact_observation_and_viewport_and_rejects_invalid_evidence() {
    for (actual, expected) in [
        (json!(59.25), CheckStatus::Passed),
        (json!(59.5), CheckStatus::Failed),
        (json!(null), CheckStatus::NotChecked),
        (json!("59.25"), CheckStatus::NotChecked),
        (json!(-1), CheckStatus::NotChecked),
        (json!(0), CheckStatus::NotChecked),
        (json!(100001), CheckStatus::NotChecked),
    ] {
        let p = height_plan();
        let mut driver = GeometryFixture {
            actual: actual.clone(),
            viewport: json!({"width":1440,"height":1080}),
            change_during_read: false,
        };
        let report =
            report_from_output(p.clone(), run(&p, &mut driver, Default::default()).unwrap());
        assert_eq!(report.results[0].status, expected);
        if expected != CheckStatus::NotChecked {
            assert_eq!(report.results[0].actual, Some(json!({"row":actual})));
            let evidence: Value =
                serde_json::from_str(report.results[0].evidence.as_ref().unwrap()).unwrap();
            assert_eq!(evidence["viewport"], driver.viewport);
        }
    }
}

#[test]
fn missing_wrong_and_changed_viewport_cannot_produce_a_height_verdict() {
    for (viewport, change_during_read) in [
        (Value::Null, false),
        (json!({"width":1280,"height":800}), false),
        (json!({"width":1440,"height":1080}), true),
    ] {
        let p = height_plan();
        let mut driver = GeometryFixture {
            actual: json!(59.25),
            viewport,
            change_during_read,
        };
        let report =
            report_from_output(p.clone(), run(&p, &mut driver, Default::default()).unwrap());
        assert_eq!(report.results[0].status, CheckStatus::NotChecked);
        assert!(report.results[0].reason.contains("viewport"));
    }
}

#[test]
fn geometry_plan_requires_bounded_viewport_and_positive_numeric_expectation() {
    let p = height_plan();
    p.draft.validate().unwrap();
    let mut invalid = p.clone();
    invalid.draft.browser.as_mut().unwrap().viewport = None;
    assert!(invalid.draft.validate().is_err());
    for (width, height) in [(0, 1080), (2561, 1080), (1440, 1601)] {
        let mut invalid = p.clone();
        invalid.draft.browser.as_mut().unwrap().viewport = Some(CheckViewport { width, height });
        assert!(invalid.draft.validate().is_err());
    }
    for expected in [
        json!(null),
        json!(-1),
        json!(0),
        json!(100001),
        json!("59.25"),
    ] {
        let mut invalid = p.clone();
        invalid.draft.criteria[0].expected = json!({"row":expected});
        assert!(invalid.draft.validate().is_err());
    }
}

#[test]
fn prepared_compact_row_draft_is_valid_but_does_not_execute() {
    let draft: crate::local_check::CheckDraft = serde_json::from_str(include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../docs/reviews/gyro-check-next-slice-2026-10-31/compact-rows-browser-draft.json"
    )))
    .unwrap();
    draft.validate().unwrap();
    assert!(draft.command.is_empty());
    assert_eq!(draft.criteria.len(), 2);
}
