//! Small, versioned model reports; full child conversations remain durable.
use super::*;
use delegated_agents::AgentSnapshot;
use serde_json::{json, Value};

pub(super) struct Options {
    max_bytes: usize,
    known: HashMap<String, String>,
}

impl Options {
    pub(super) fn parse(arguments: &Value) -> anyhow::Result<Self> {
        let known = arguments
            .get("knownRevisions")
            .map(|value| serde_json::from_value(value.clone()))
            .transpose()
            .map_err(|_| anyhow::anyhow!("knownRevisions must map agent IDs to revision strings"))?
            .unwrap_or_default();
        Ok(Self {
            max_bytes: workspace_result_byte_limit(arguments)?,
            known,
        })
    }
}

fn revision(agent: &AgentSnapshot) -> String {
    format!("{}:{}", agent.run_id, agent.updated_at)
}

pub(super) fn render(snapshots: &[AgentSnapshot], options: &Options) -> anyhow::Result<Value> {
    let render = |limit: usize| {
        let agents = snapshots.iter().map(|agent| {
            let revision = revision(agent);
            if options.known.get(&agent.agent_id) == Some(&revision) {
                return json!({"agentId":agent.agent_id, "runId":agent.run_id,
                    "status":agent.status, "revision":revision, "unchanged":true});
            }
            let (summary, truncated) = subagent_capability::truncate_chars(agent.summary.as_deref().unwrap_or(""), limit);
            json!({
                "agentId":agent.agent_id, "name":agent.name, "status":agent.status,
                "readOnly":agent.read_only, "providerId":agent.provider_id, "modelId":agent.model_id,
                "tokens":agent.tokens, "elapsedMs":agent.elapsed_ms, "runId":agent.run_id,
                "revision":revision, "summary":summary,
                "summaryTruncated":truncated || agent.summary.as_ref().is_some_and(|text| text.chars().count() >= 8_000),
                "error":agent.error.as_ref().map(|text| subagent_capability::truncate_chars(text, 120).0),
            })
        }).collect::<Vec<_>>();
        redact_json_strings(json!({"schema":"gyro.agents.v1", "agents":agents}))
    };
    let (mut low, mut high) = (0usize, 8_000usize);
    while low < high {
        let middle = low + (high - low).div_ceil(2);
        if serde_json::to_vec(&render(middle))?.len() <= options.max_bytes {
            low = middle;
        } else {
            high = middle - 1;
        }
    }
    let data = render(low);
    if serde_json::to_vec(&data)?.len() > options.max_bytes {
        anyhow::bail!("Agent report metadata exceeds maxBytes; request fewer agents or increase the byte budget");
    }
    Ok(data)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn snapshot() -> AgentSnapshot {
        serde_json::from_value(json!({
            "agentId":"child", "parentSessionId":"parent", "parentTurnId":"turn",
            "name":"Parser", "task":"Inspect parser", "providerId":"openai", "modelId":null,
            "readOnly":true, "status":"completed", "createdAt":"2026-10-11T10:00:00Z",
            "updatedAt":"2026-10-11T10:01:00Z", "startedAt":null, "elapsedMs":60000,
            "tokens":null, "runId":"run-1", "summary":"verified parser behavior\n".repeat(300), "error":null,
        })).unwrap()
    }

    #[test]
    fn unchanged_report_reuses_revision_without_repeating_completed_text() {
        let mut agent = snapshot();
        let first = render(&[agent.clone()], &Options::parse(&json!({})).unwrap()).unwrap();
        let args = json!({"knownRevisions":{"child":first["agents"][0]["revision"]}});
        let next = render(&[agent.clone()], &Options::parse(&args).unwrap()).unwrap();
        assert_eq!(next["agents"][0]["unchanged"], true);
        assert!(next["agents"][0].get("summary").is_none());
        let before = serde_json::to_vec(&first).unwrap().len();
        let after = serde_json::to_vec(&next).unwrap().len();
        assert!(after * 10 < before);
        println!("Agent report repeated observation: {before} -> {after} bytes");
        agent.run_id = "run-2".into();
        agent.status = "failed".into();
        agent.error = Some("new failure".into());
        let changed = render(&[agent], &Options::parse(&args).unwrap()).unwrap();
        assert_eq!(changed["agents"][0]["error"], "new failure");
        assert!(changed["agents"][0].get("unchanged").is_none());
    }

    #[test]
    fn reports_bound_escaped_text_and_can_request_one_full_result() {
        let mut agent = snapshot();
        agent.summary = Some("😀\n\"".repeat(2_000));
        let agents = (0..8)
            .map(|index| {
                let mut agent = agent.clone();
                agent.agent_id = format!("child-{index}");
                agent
            })
            .collect::<Vec<_>>();
        let data = render(&agents, &Options::parse(&json!({})).unwrap()).unwrap();
        assert_eq!(data["agents"].as_array().unwrap().len(), 8);
        assert!(serde_json::to_vec(&data).unwrap().len() <= DEFAULT_WORKSPACE_RESULT_BYTES);
        assert_eq!(data["agents"][0]["summaryTruncated"], true);
        let full = render(
            &[agent.clone()],
            &Options::parse(&json!({"maxBytes":131072})).unwrap(),
        )
        .unwrap();
        assert_eq!(full["agents"][0]["summary"], agent.summary.unwrap());
    }
}
