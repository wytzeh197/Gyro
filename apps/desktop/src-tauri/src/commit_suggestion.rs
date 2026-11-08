//! Let a completed implementation offer a local commit through the existing
//! question card. The answer returns to the same chat and normal tool policy.
use crate::providers::chat_types::{ChatMode, ProviderChatRequest};

const COMMIT_QUESTION_EXAMPLE: &str = r#"
GYRO_QUESTIONS: {"questions":[{"question":"Should I commit these changes?","options":[{"label":"Commit changes","detail":"Create a local commit of this task's changes."},{"label":"Review first","detail":"Show the diff and proposed commit message before committing."},{"label":"Not now","detail":"Leave the changes uncommitted."}]}]}
"#;

const COMMIT_SUGGESTION_INSTRUCTION: &str = "After completing and verifying requested edits, use fresh gyro_workspace_git_status and scoped diffs to confirm this task's uncommitted changes. Summarize the result, checks, and proposed commit scope, then ask 'Should I commit these changes?' through the existing question card: Commit changes (local only), Review first, or Not now. Skip this offer for read-only, failed, or unfinished work, clean or non-Git workspaces, conflicts, or others' changes. Honor prior authorization without asking again; respect refusals and do not repeat declined or skipped offers for the same changes. Delegated sub-agents report to their parent instead. Review first means show the diff and proposed message, then wait for commit confirmation. Not now, skipping, dismissal, and silence never authorize committing. After approval, recheck status and diffs, preserve unrelated staged and unstaged changes, commit only the agreed scope through available tools and existing approval policy, and confirm the resulting commit. Ask if the scope cannot be safely separated. A local commit needs no GitHub sign-in; connection or commit approval never authorizes push, PR, merge, or release. Only check gyro_github_status for a separately requested GitHub action.";

pub(super) fn guidance(
    request: &ProviderChatRequest,
    supports_tools: bool,
    resumed: bool,
) -> Option<String> {
    (supports_tools
        && request.mode == ChatMode::Normal
        && request
            .workspace_path
            .as_deref()
            .is_some_and(|path| !path.trim().is_empty()))
    .then(|| {
        if resumed {
            COMMIT_SUGGESTION_INSTRUCTION.to_string()
        } else {
            format!(
                "{COMMIT_SUGGESTION_INSTRUCTION}\n{}",
                COMMIT_QUESTION_EXAMPLE.trim()
            )
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::providers::{
        markers::strip_hidden_control_markers,
        prompt::{provider_context_message_with_capabilities_for_turn, PromptTurn},
    };

    fn request() -> ProviderChatRequest {
        serde_json::from_value(serde_json::json!({
            "sessionId": "commit-suggestion-test",
            "providerId": "anthropic",
            "message": "Fix the search bug.",
            "workspacePath": "/tmp/project",
        }))
        .unwrap()
    }

    fn prompt(request: &ProviderChatRequest, tools: bool, resumed: bool) -> String {
        provider_context_message_with_capabilities_for_turn(
            request,
            None,
            tools,
            false,
            PromptTurn {
                resumed,
                approvals_sent_separately: false,
            },
        )
    }

    #[test]
    fn commit_suggestion_reaches_new_and_resumed_workspace_turns() {
        let mut request = request();
        for provider in ["anthropic", "openai", "google", "ollama"] {
            request.provider_id = provider.into();
            for resumed in [false, true] {
                let prompt = prompt(&request, true, resumed);
                assert_eq!(prompt.matches(COMMIT_SUGGESTION_INSTRUCTION).count(), 1);
                assert_eq!(prompt.contains(COMMIT_QUESTION_EXAMPLE.trim()), !resumed);
            }
        }
    }

    #[test]
    fn commit_suggestion_is_absent_without_mutating_workspace_tools() {
        let mut request = request();
        for resumed in [false, true] {
            for mode in [ChatMode::Plan, ChatMode::Council] {
                request.mode = mode;
                assert!(!prompt(&request, true, resumed).contains(COMMIT_SUGGESTION_INSTRUCTION));
            }
            request.mode = ChatMode::Normal;
            assert!(!prompt(&request, false, resumed).contains(COMMIT_SUGGESTION_INSTRUCTION));
            for path in [None, Some("".into()), Some("  ".into())] {
                request.workspace_path = path;
                assert!(!prompt(&request, true, resumed).contains(COMMIT_SUGGESTION_INSTRUCTION));
            }
            request.workspace_path = Some("/tmp/project".into());
        }
    }

    #[test]
    fn commit_suggestion_example_becomes_a_question_payload() {
        let marker = COMMIT_QUESTION_EXAMPLE.trim();
        let reply =
            strip_hidden_control_markers(&format!("Fixed search; checks passed.\n{marker}"));
        assert_eq!(reply.message.trim(), "Fixed search; checks passed.");
        let questions = reply.questions.unwrap();
        assert_eq!(
            questions["questions"][0]["question"],
            "Should I commit these changes?"
        );
        let options = questions["questions"][0]["options"].as_array().unwrap();
        assert_eq!(options.len(), 3);
        assert!(options.iter().all(|option| option["label"].is_string()));
        assert!(options
            .iter()
            .all(|option| option.get("recommended").is_none()));
    }
}
