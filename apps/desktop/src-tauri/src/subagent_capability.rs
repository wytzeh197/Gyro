//! `gyro_research`: one bounded, read-only provider run in a fresh context.
//!
//! A research sub-agent is a real chat turn in its own session, run in Plan
//! mode, so it inherits the capability policy that already exists for
//! read-only work instead of a hand-rolled tool filter: inspection tools are
//! advertised, and every writing class is denied by the broker. That also makes
//! recursion impossible rather than merely discouraged — this capability's own
//! class is denied in Plan mode, so a sub-agent cannot start another one.
//!
//! The child session is kept rather than deleted, so the cached research is
//! auditable, and only its final assistant message is returned to the parent.
//! The call blocks the parent's tool call until the child finishes; the child's
//! provider run carries the same timeouts and usage metering as any other turn,
//! attributed to the sub-agent origin so its cost is visible on its own.
use super::*;
use serde_json::{json, Value};

const SUBAGENT_SCHEMA: &str = "gyro.subagent.v1";
const MAX_QUESTION_CHARS: usize = 4_000;
const MAX_SUMMARY_CHARS: usize = 8_000;
const MAX_TITLE_CHARS: usize = 60;

pub(super) fn execute(
    app: &tauri::AppHandle,
    bound: &BoundProviderCapabilityContext,
    request: &CapabilityRequest,
) -> anyhow::Result<(String, Value, Option<CapabilityResourceRef>)> {
    let question = normalize_question(capability_argument_string(&request.arguments, "question")?)?;
    let store = open_store().map_err(anyhow::Error::msg)?;
    let parent_id = Uuid::parse_str(&bound.session_id)?;
    let parent = store
        .get_session(parent_id)?
        .ok_or_else(|| anyhow::anyhow!("the chat that asked for research no longer exists"))?;
    let provider_id = parent
        .provider_id
        .clone()
        .ok_or_else(|| anyhow::anyhow!("this chat has no provider selected"))?;
    let child = store.create_session_with_context(
        &parent.workspace_path,
        SessionOrigin::Desktop,
        format!("Research: {}", title_from(&question)),
        CreateSessionContext {
            workspace_mode: parent.workspace_mode,
            branch: parent.branch.clone(),
            worktree_name: parent.worktree_name.clone(),
            provider_id: Some(provider_id.clone()),
            provider_label: parent.provider_label.clone(),
            model_id: parent.model_id.clone(),
            model_label: parent.model_label.clone(),
            reasoning_effort: parent.reasoning_effort.clone(),
        },
    )?;
    let response = run_provider_chat_blocking(
        app.clone(),
        ProviderChatRequest {
            session_id: child.id.to_string(),
            message: research_prompt(&question),
            turn_id: Some(Uuid::new_v4().to_string()),
            provider_id,
            provider_label: child.provider_label.clone(),
            model_id: child.model_id.clone(),
            model_label: child.model_label.clone(),
            reasoning_effort: child.reasoning_effort.clone(),
            // Read-only work still asks before anything unusual, and never
            // inherits the parent's Full Access.
            require_command_approval: true,
            require_file_edit_approval: true,
            full_access: false,
            suggest_title: false,
            workspace_path: Some(parent.workspace_path.to_string_lossy().to_string()),
            mode: ChatMode::Plan,
            goal: None,
            plan: None,
            attachments: Vec::new(),
            workspace_context: None,
            workspace_check: None,
        },
        UsageOrigin::SubAgent,
    )
    .map_err(|error| anyhow::anyhow!("the research sub-agent did not finish: {error}"))?;
    let (summary, truncated) = truncate_chars(&response.assistant_event.message, MAX_SUMMARY_CHARS);
    let resource = CapabilityResourceRef {
        id: child.id.to_string(),
        kind: "chat".into(),
        label: child.title.clone(),
    };
    Ok((
        format!("Research finished in chat {}", child.id),
        json!({
            "schema": SUBAGENT_SCHEMA,
            "sessionId": child.id,
            "title": child.title,
            "providerId": child.provider_id,
            "modelId": child.model_id,
            "question": question,
            "truncated": truncated,
            "summary": summary,
        }),
        Some(resource),
    ))
}

/// A sub-agent gets a question, not a conversation: it is told what it is, that
/// it may only read, and that the parent wants findings rather than a plan.
fn research_prompt(question: &str) -> String {
    format!(
        "You are a read-only research sub-agent started by another Gyro chat. \
         Answer the question below using only read-only tools (search, read, code navigation, git history). \
         You cannot write files, run commands, or fetch the web. \
         Work from evidence in this workspace, and when you are done reply with a short report: \
         the findings, the file paths and line numbers that support them, and anything you could not determine. \
         Do not produce a plan or ask for approval; the chat that started you will relay your report.\n\n\
         Question: {question}"
    )
}

fn normalize_question(value: &str) -> anyhow::Result<String> {
    let collapsed = value.split_whitespace().collect::<Vec<_>>().join(" ");
    if collapsed.is_empty() {
        anyhow::bail!("capability argument `question` is required");
    }
    if collapsed.chars().count() > MAX_QUESTION_CHARS {
        anyhow::bail!("a research question is limited to {MAX_QUESTION_CHARS} characters");
    }
    Ok(collapsed)
}

fn title_from(question: &str) -> String {
    truncate_chars(question, MAX_TITLE_CHARS).0
}

fn truncate_chars(value: &str, limit: usize) -> (String, bool) {
    if value.chars().count() <= limit {
        return (value.to_string(), false);
    }
    (value.chars().take(limit).collect::<String>(), true)
}

/// Tool schemas live here so `lib.rs` keeps a single delegation guard instead
/// of one delegation arm per capability.
pub(super) fn schema(id: CapabilityId) -> Option<(Value, Vec<&'static str>)> {
    let (properties, required) = match id {
        CapabilityId::ResearchRun => (
            json!({
                "question": {
                    "type": "string",
                    "description": "One self-contained research question. The sub-agent starts with no memory of this chat, so include the paths, symbols, or behaviour it needs to know about."
                }
            }),
            vec!["question"],
        ),
        _ => return None,
    };
    Some((properties, required))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn questions_collapse_whitespace_and_are_bounded() {
        assert_eq!(
            normalize_question("  where\nis   the parser? ").unwrap(),
            "where is the parser?"
        );
        assert!(normalize_question("   ").is_err());
        let long = "x".repeat(MAX_QUESTION_CHARS + 1);
        assert!(normalize_question(&long).is_err());
    }

    #[test]
    fn the_prompt_states_the_question_and_the_read_only_contract() {
        let prompt = research_prompt("how does the capability broker work?");
        assert!(prompt.contains("read-only research sub-agent"));
        assert!(prompt.contains("cannot write files"));
        assert!(
            prompt.contains("How does") || prompt.contains("how does the capability broker work?")
        );
        assert!(prompt.contains("Do not produce a plan"));
    }

    #[test]
    fn titles_are_short_enough_for_a_chat_list() {
        let title = title_from(&"word ".repeat(40));
        assert!(title.chars().count() <= MAX_TITLE_CHARS);
        assert_eq!(title_from("short question"), "short question");
    }

    #[test]
    fn summaries_are_truncated_rather_than_dumped() {
        let long = "y".repeat(MAX_SUMMARY_CHARS + 10);
        let (summary, truncated) = truncate_chars(&long, MAX_SUMMARY_CHARS);
        assert!(truncated);
        assert_eq!(summary.chars().count(), MAX_SUMMARY_CHARS);
        let (short, truncated) = truncate_chars("done", MAX_SUMMARY_CHARS);
        assert!(!truncated);
        assert_eq!(short, "done");
    }

    #[test]
    fn schema_requires_a_question_and_ignores_other_capabilities() {
        let (properties, required) = schema(CapabilityId::ResearchRun).unwrap();
        assert!(properties["question"].is_object());
        assert_eq!(required, vec!["question"]);
        assert!(schema(CapabilityId::CodeDefinition).is_none());
    }
}
