//! Deterministic evidence extraction; raw logs remain authoritative and retrievable.
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Evidence {
    pub format: String,
    pub coverage: String,
    pub exit_code: Option<i64>,
    pub totals: Value,
    pub failures: Vec<Value>,
}
pub fn parse(stdout: &str, stderr: &str, exit_code: Option<i64>) -> Option<Evidence> {
    let text = if stderr.is_empty() {
        stdout.to_owned()
    } else {
        format!("{stdout}\n{stderr}")
    };
    if let Ok(Value::Array(files)) = serde_json::from_str::<Value>(stdout.trim()) {
        if !files.is_empty()
            && files
                .iter()
                .all(|f| f["messages"].is_array() && f["filePath"].is_string())
        {
            let mut failures = Vec::new();
            let mut errors = 0u64;
            let mut warnings = 0u64;
            for f in files {
                errors += f["errorCount"].as_u64().unwrap_or(0);
                warnings += f["warningCount"].as_u64().unwrap_or(0);
                for m in f["messages"].as_array().unwrap() {
                    let mut m = m.clone();
                    m["path"] = f["filePath"].clone();
                    failures.push(m);
                }
            }
            return Some(Evidence {
                format: "eslint-json".into(),
                coverage: "complete".into(),
                exit_code,
                totals: json!({"errors":errors,"warnings":warnings}),
                failures,
            });
        }
    }
    let mut diagnostics = Vec::new();
    let mut cargo_json = false;
    for line in stdout.lines() {
        if let Ok(v) = serde_json::from_str::<Value>(line) {
            if v["reason"] == "compiler-message" {
                cargo_json = true;
                diagnostics.push(v["message"].clone());
            }
        }
    }
    if cargo_json {
        return Some(Evidence {
            format: "cargo-json".into(),
            coverage: "partial".into(),
            exit_code,
            totals: json!({"diagnostics":diagnostics.len()}),
            failures: diagnostics,
        });
    }
    let lines = text.lines().collect::<Vec<_>>();
    let mut totals = serde_json::Map::new();
    let mut failures = Vec::new();
    let mut format = None;
    for (i, line) in lines.iter().enumerate() {
        if line.starts_with("test result:") {
            format = Some("cargo-test");
            for key in ["passed", "failed", "ignored", "measured", "filtered out"] {
                if let Some(part) = line.split(';').find(|p| p.trim().ends_with(key)) {
                    if let Some(n) = part
                        .split_whitespace()
                        .rev()
                        .nth(key.split_whitespace().count())
                        .and_then(|x| x.parse::<u64>().ok())
                    {
                        let old = totals.get(key).and_then(Value::as_u64).unwrap_or(0);
                        totals.insert(key.into(), json!(old + n));
                    }
                }
            }
        }
        if line.starts_with("---- ") && line.ends_with(" ----") {
            let end = lines
                .iter()
                .enumerate()
                .skip(i + 1)
                .find(|(_, l)| {
                    l.starts_with("---- ")
                        || l.starts_with("failures:")
                        || l.starts_with("test result:")
                })
                .map_or(lines.len(), |(n, _)| n);
            failures.push(json!({"message":lines[i..end].join("\n")}));
        }
        if line.starts_with("TAP version ") || line.starts_with("# tests ") {
            format = Some("node-tap");
        }
        for key in ["tests", "pass", "fail", "cancelled", "skipped", "todo"] {
            if let Some(n) = line
                .strip_prefix(&format!("# {key} "))
                .and_then(|s| s.trim().parse::<u64>().ok())
            {
                totals.insert(key.into(), json!(n));
            }
        }
        if line.trim_start().starts_with("not ok ") {
            format = Some("node-tap");
            let end = lines
                .iter()
                .enumerate()
                .skip(i + 1)
                .find(|(_, l)| {
                    l.starts_with("ok ")
                        || l.starts_with("not ok ")
                        || l.starts_with("1..")
                        || l.starts_with("# tests ")
                })
                .map_or(lines.len(), |(n, _)| n);
            failures.push(json!({"message":lines[i..end].join("\n")}));
        }
        if line.contains(": error TS") || line.contains("): error TS") {
            format = Some("typescript");
            failures.push(json!({"message":line}));
        }
    }
    let mut unique = std::collections::HashSet::new();
    failures.retain(|f| unique.insert(f.to_string()));
    format.map(|f| Evidence {
        format: f.into(),
        coverage: "partial".into(),
        exit_code,
        totals: Value::Object(totals),
        failures,
    })
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cargo_preserves_failure_and_exit() {
        let e=parse("---- reconnect ----\nthread panicked: exact 🦀\nfailures:\n reconnect\ntest result: FAILED. 4 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out;\n","",Some(101)).unwrap();
        assert_eq!(e.exit_code, Some(101));
        assert_eq!(e.totals["passed"], 4);
        assert!(e.failures[0]["message"]
            .as_str()
            .unwrap()
            .contains("exact 🦀"));
    }
    #[test]
    fn unknown_falls_back() {
        assert!(parse("arbitrary output", "", Some(0)).is_none());
    }
    #[test]
    fn tap_keeps_stack() {
        let e=parse("TAP version 13\nnot ok 1 - reconnect\n  ---\n  stack: exact failure\n  ...\n1..1\n# tests 1\n# fail 1","",Some(1)).unwrap();
        assert!(e.failures[0]["message"]
            .as_str()
            .unwrap()
            .contains("stack: exact failure"));
    }
    #[test]
    fn typescript_exact() {
        let e = parse("src/a.ts(2,3): error TS2322: not assignable.", "", Some(2)).unwrap();
        assert_eq!(e.coverage, "partial");
        assert_eq!(e.failures.len(), 1);
    }
    #[test]
    fn eslint_paths() {
        let e=parse(r#"[{"filePath":"src/a.ts","errorCount":1,"warningCount":0,"messages":[{"message":"exact","line":2,"severity":2}]}]"#,"",Some(1)).unwrap();
        assert_eq!(e.failures[0]["path"], "src/a.ts");
    }
}
