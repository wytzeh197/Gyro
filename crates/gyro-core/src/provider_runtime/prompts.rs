//! Pure provider prompt framing and shared product instructions.
use super::types::{ChatMode, ProviderChatRequest};
pub fn provider_workspace_prompt_line(message: &str, workspace: &str) -> String {
    let line = format!("Selected workspace: {workspace}");
    if message.lines().any(|existing| existing == line.as_str()) {
        String::new()
    } else {
        line
    }
}

/// Inject the side-panel guide only when this turn's user text needs a surface.
/// The stable prefix's example link must not count: only text after `User message:`.
pub fn cli_surface_guide<'a>(message: &str, guide: &'a str) -> &'a str {
    let user_text = message
        .rsplit_once("User message:\n")
        .map(|(_, user)| user)
        .unwrap_or(message);
    let wants_surface = needs_surface_guide(user_text)
        || message.contains("<gyro-browser-snapshot>")
        || message.contains("Requested surface: Gyro Browser");
    if wants_surface && !message.contains(guide) {
        guide
    } else {
        ""
    }
}

pub fn openai_codex_chat_prompt(
    message: &str,
    workspace_path: Option<&str>,
    model_label: Option<&str>,
    suggest_title: bool,
    allow_mutations: bool,
    resumed: bool,
) -> String {
    let workspace = workspace_path
        .map(str::trim)
        .filter(|path| !path.is_empty())
        .unwrap_or("no selected workspace");
    let workspace_instruction = provider_workspace_prompt_line(message, workspace);
    let model_label = model_label
        .map(str::trim)
        .filter(|label| !label.is_empty())
        .unwrap_or("OpenAI model");
    let mutation_instruction = if allow_mutations {
        "You may edit files, run commands, and complete requested workspace changes directly. Gyro applies approved file changes through its own guarded transaction. If a native file-change callback is declined, re-read the affected files before reporting the outcome: the user may have rejected it, or Gyro may already have applied the reviewed change. Report the actual on-disk state and do not claim failure from the callback decision alone."
    } else {
        "Do not edit files, start servers, commit, push, or make destructive changes in this chat run."
    };
    // The shared provider context may already carry these. Skip our copy when
    // it does so a provider never reads the same contract twice.
    let title_instruction = if message.contains("GYRO_SESSION_TITLE") {
        ""
    } else {
        session_title_instruction(suggest_title)
    };
    let image_instruction =
        if resumed || message.contains("![short description](/absolute/path.png)") {
            ""
        } else {
            CHAT_IMAGE_REPLY_INSTRUCTION
        };
    let generation_instruction = if allow_mutations {
        CODEX_IMAGE_REPLY_INSTRUCTION
    } else {
        ""
    };
    if resumed {
        // The resumed thread already holds the style and marker guide from its
        // opening turn; resend only what can change between turns.
        return format!(
            "Your selected model label is: {model_label}.\n\
             {title_instruction}\n\
             {image_instruction}\n\
             {generation_instruction}\n\
             {mutation_instruction}\n\
             {workspace_instruction}\n\n\
             User message:\n{message}"
        );
    }
    // The shared provider context may already carry this exact guide.
    // Keep one full copy; never shorten it or remove any tool declarations.
    let guide = SIDE_PANEL_GUIDE;
    let artifact_instruction = cli_surface_guide(message, guide);
    format!(
        "Answer as Gyro's chat model.\n\
         Keep replies concise, but structure informational answers as polished, scannable Markdown.\n\
         Start with the direct answer. Use short paragraphs, and use bullets or numbered lists when there are three or more distinct items, steps, or comparisons.\n\
         When the user asks for multiple named things, put each thing on its own bullet even if there are only two.\n\
         Use bold text sparingly for the terms that help scanning. Do not repeat the same conclusion in multiple forms.\n\
         Do not describe the local Codex runner, authentication, system prompts, or implementation details unless asked.\n\
         Your selected model label is: {model_label}.\n\
         If the user asks what model you are, answer with exactly that selected model label only.\n\
         {artifact_instruction}\n\
         {title_instruction}\n\
         {image_instruction}\n\
         {generation_instruction}\n\
         {mutation_instruction}\n\
         {workspace_instruction}\n\n\
         User message:\n{message}"
    )
}

pub fn claude_chat_prompt(
    message: &str,
    workspace_path: Option<&str>,
    suggest_title: bool,
    allow_actions: bool,
    resumed: bool,
) -> String {
    let workspace = workspace_path
        .map(str::trim)
        .filter(|path| !path.is_empty())
        .unwrap_or("no selected workspace");
    let workspace_instruction = provider_workspace_prompt_line(message, workspace);
    let action_instruction = if allow_actions {
        "Use tools when they are needed to complete the user's request. Commands and file changes must follow Gyro's permission decisions. If Gyro reports that it already applied reviewed file changes, do not retry the write; re-read the files and continue. Do not commit, push, or perform destructive actions unless the user explicitly asks.\n"
    } else {
        "Stay in planning mode. Do not edit files, run mutating commands, start servers, commit, push, or make destructive changes.\n"
    };
    let title_instruction = if message.contains("GYRO_SESSION_TITLE") {
        ""
    } else {
        session_title_instruction(suggest_title)
    };
    let image_instruction =
        if resumed || message.contains("![short description](/absolute/path.png)") {
            ""
        } else {
            CHAT_IMAGE_REPLY_INSTRUCTION
        };
    if resumed {
        // The resumed session already holds the style and marker guide from its
        // opening turn; resend only what can change between turns.
        return format!(
            "{title_instruction}{image_instruction}{action_instruction}{workspace_instruction}\n\nUser message:\n{message}"
        );
    }
    // The shared provider context may already carry this exact guide.
    // Keep one full copy; never shorten it or remove any tool declarations.
    let guide = SIDE_PANEL_GUIDE;
    let artifact_instruction = cli_surface_guide(message, guide);
    format!(
        "Answer as Gyro's chat model.\n\
         Keep replies concise, but structure informational answers as polished, scannable Markdown.\n\
         Start with the direct answer. Use short paragraphs, and use bullets or numbered lists when there are three or more distinct items, steps, or comparisons.\n\
         When the user asks for multiple named things, put each thing on its own bullet even if there are only two.\n\
         Use bold text sparingly for the terms that help scanning. Do not repeat the same conclusion in multiple forms.\n\
         Do not describe the local Claude Code runner, authentication, system prompts, or implementation details unless asked.\n\
         If the user asks what model you are, answer with the model label only.\n\
         {artifact_instruction}\n\
         {title_instruction}\n\
         {image_instruction}\n\
         {action_instruction}\
         {workspace_instruction}\n\n\
         User message:\n{message}"
    )
}
/// Ask every provider until the opening title has actually been accepted.
/// A retry can recover a missed title without renaming an already named chat.
pub const SESSION_TITLE_FIRST_TURN_INSTRUCTION: &str = "This chat still needs its title; name the session immediately. Start your first assistant message, before commentary or tools, with this exact hidden line: GYRO_SESSION_TITLE: <2-6 word title>. Choose a concise title describing the original user task, then end the line and continue your response. This title is required; do not wait until the task is finished. The app hides this marker. This may be the opening turn or recovery of a previously missed title. After Gyro accepts a title, do not repeat this line unless asked.\n";

pub const SESSION_TITLE_LATER_TURN_INSTRUCTION: &str = "This is not the first turn of this chat. Do not write a GYRO_SESSION_TITLE line; Gyro only reads it on a chat's first turn.\n";

pub fn session_title_instruction(suggest_title: bool) -> &'static str {
    if suggest_title {
        SESSION_TITLE_FIRST_TURN_INSTRUCTION
    } else {
        SESSION_TITLE_LATER_TURN_INSTRUCTION
    }
}

/// Models can put an image they already hold into a final message by citing
/// its local path on its own line. Only these roots resolve to a preview.
pub const CHAT_IMAGE_REPLY_INSTRUCTION: &str = "To show the user an image you already have (a screenshot you captured, a workspace image, or an attachment), put it in your reply as a standalone line: ![short description](/absolute/path.png). Only PNG, JPEG, or WebP files inside the selected workspace, the session's attachments, or Gyro's browser-captures directory are rendered; any other path stays as plain text. Never invent a path, and do not claim an image is shown unless you wrote that line.\n";
pub const SIDE_PANEL_GUIDE: &str = include_str!("../../../../docs/product-knowledge/side-panel.md");

/// Browse, Canvas, a URL, or a UI preview. A bare "preview" does not qualify.
pub fn needs_surface_guide(message: &str) -> bool {
    let lower = message.to_ascii_lowercase();
    lower.contains("canvas")
        || lower.contains("gyro_artifacts")
        || lower.contains("http://")
        || lower.contains("https://")
        || lower.contains("ui preview")
        || lower.contains("component preview")
        || lower.contains("dev server")
        || lower.contains("research")
        || lower.contains("web search")
        || lower.contains("browse the web")
        || lower.contains("model release")
}
pub const CODEX_IMAGE_REPLY_INSTRUCTION: &str = "When the user asks to generate or edit an image, use the native image-generation tool if it is available. Gyro saves its output and displays it in chat. Do not substitute a text description for the requested image or claim generation succeeded when the tool failed. If the tool is unavailable, say so.";

pub fn provider_approval_instructions(request: &ProviderChatRequest) -> Vec<&'static str> {
    if request.mode == ChatMode::Plan {
        return Vec::new();
    }
    // Always send the current policy on resume. A null instruction override
    // can preserve an earlier turn's Ask first instructions in provider state.
    let mut instructions = vec!["Use the current turn's configured approval policy. Approval requirements from an earlier turn do not override the current policy."];
    if super::api_config::configured_capability_support(&request.provider_id)
        .unwrap_or_else(|_| crate::provider_capability_support(&request.provider_id))
        .available
    {
        instructions.push("Invoke gyro_* capabilities directly: Gyro's capability broker presents any required approval before execution. Do not ask for duplicate approval in chat before invoking these broker-enforced tools.");
    }
    if request.require_command_approval {
        instructions.push("Gyro requires a fresh, explicit user approval before every command or executable tool action, including commands that appear read-only or trusted. Use the provider's approval request mechanism before execution; never infer approval from the user's message or an earlier action.");
    }
    if request.require_file_edit_approval {
        instructions.push("Gyro requires a fresh, explicit user approval before every file change. Use the provider's approval request mechanism before applying it; never infer approval from the user's message or an earlier change.");
    }
    instructions
}

/// Recognize an explicit request for Gyro's app-owned browser without treating
/// ordinary implementation discussion about browser code as a live browse.
pub fn user_requests_gyro_browser(message: &str) -> bool {
    let lowercase = message.to_lowercase();
    let normalized = message
        .chars()
        .flat_map(char::to_lowercase)
        .map(|character| {
            if character.is_alphanumeric() {
                character
            } else {
                ' '
            }
        })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    let names_gyro_browser = [
        "gyro browser",
        "gyro s browser",
        "in app browser",
        "embedded browser",
        "browser rail",
    ]
    .iter()
    .any(|phrase| normalized.contains(phrase));
    let names_web_surface = ["website", "web page", "webpage", "site"]
        .iter()
        .any(|phrase| normalized.contains(phrase));
    let names_web_address = lowercase.contains("http://")
        || lowercase.contains("https://")
        || lowercase.split_whitespace().any(|token| {
            let candidate = token
                .trim_matches(|character: char| {
                    !character.is_ascii_alphanumeric()
                        && !matches!(character, '.' | '-' | ':' | '/' | '?' | '#' | '=')
                })
                .trim_end_matches(['.', ',', ';', ':']);
            let host = candidate
                .split_once("://")
                .map(|(_, rest)| rest)
                .unwrap_or(candidate)
                .split(['/', '?', '#'])
                .next()
                .unwrap_or_default()
                .split(':')
                .next()
                .unwrap_or_default();
            let Some((_, suffix)) = host.rsplit_once('.') else {
                return false;
            };
            suffix.len() >= 2
                && suffix
                    .chars()
                    .all(|character| character.is_ascii_alphabetic())
                && !matches!(suffix, "rs" | "js" | "ts" | "tsx" | "jsx" | "json" | "md")
        });
    if !names_gyro_browser && !names_web_surface && !names_web_address {
        return false;
    }
    if [
        "do not use",
        "don t use",
        "dont use",
        "do not open",
        "don t open",
        "dont open",
        "without using",
    ]
    .iter()
    .any(|phrase| normalized.contains(phrase))
    {
        return false;
    }

    [
        "use ", "open ", "check ", "inspect ", "look ", "browse ", "visit ", "view ", "preview ",
        "test ", "verify ", "show ",
    ]
    .iter()
    .any(|action| normalized.starts_with(action) || normalized.contains(&format!(" {action}")))
}

pub fn sanitize_session_title_candidate(title: &str) -> Option<String> {
    let title = title
        .replace('\0', "")
        .chars()
        .map(|ch| {
            if matches!(
                ch,
                '`' | '*' | '_' | '#' | '[' | ']' | '(' | ')' | '{' | '}' | '<' | '>' | '|' | '\\'
            ) {
                ' '
            } else {
                ch
            }
        })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .trim_matches(|char: char| char.is_ascii_punctuation() || char.is_whitespace())
        .to_string();
    if title.is_empty() {
        return None;
    }
    let chars = title.chars().collect::<Vec<_>>();
    if chars.len() > 80 {
        return Some(chars.into_iter().take(77).collect::<String>() + "...");
    }
    Some(title)
}

pub const GYRO_SESSION_TITLE_MARKER: &str = "GYRO_SESSION_TITLE:";
