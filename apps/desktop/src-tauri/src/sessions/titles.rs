use crate::sanitize_session_title_candidate;
/// Placeholder titles a new chat still has when its first message arrives.
/// A title the user already chose is left alone.
pub(crate) fn is_generic_session_title(title: &str) -> bool {
    // A title with no letters is a marker or a placeholder ("1", "-"), never
    // a name the user chose, so the model may still replace it.
    if !title.chars().any(char::is_alphabetic) {
        return true;
    }
    matches!(
        title.trim(),
        "" | "Desktop session"
            | "New chat"
            | "Worktree session"
            | "Agent workspace"
            | "CLI workspace"
            | "Worktree CLI workspace"
            | "Agent workspace CLI"
            | "Provider session"
            | "Chat handoff"
            | "Gyro session"
            | "Untitled chat"
    )
}

/// Ask every provider until the opening title has actually been accepted.
/// A retry can recover a missed title without renaming an already named chat.
pub(crate) const SESSION_TITLE_FIRST_TURN_INSTRUCTION: &str = "This chat still needs its title; name the session immediately. Start your first assistant message, before commentary or tools, with this exact hidden line: GYRO_SESSION_TITLE: <2-6 word title>. Choose a concise title describing the original user task, then end the line and continue your response. This title is required; do not wait until the task is finished. The app hides this marker. This may be the opening turn or recovery of a previously missed title. After Gyro accepts a title, do not repeat this line unless asked.\n";
pub(crate) const SESSION_TITLE_LATER_TURN_INSTRUCTION: &str = "This is not the first turn of this chat. Do not write a GYRO_SESSION_TITLE line; Gyro only reads it on a chat's first turn.\n";

pub(crate) fn session_title_instruction(suggest_title: bool) -> &'static str {
    if suggest_title {
        SESSION_TITLE_FIRST_TURN_INSTRUCTION
    } else {
        SESSION_TITLE_LATER_TURN_INSTRUCTION
    }
}

/// Models can put an image they already hold into a final message by citing
/// its local path on its own line. Only these roots resolve to a preview.
pub(crate) const CHAT_IMAGE_REPLY_INSTRUCTION: &str = "To show the user an image you already have (a screenshot you captured, a workspace image, or an attachment), put it in your reply as a standalone line: ![short description](/absolute/path.png). Only PNG, JPEG, or WebP files inside the selected workspace, the session's attachments, or Gyro's browser-captures directory are rendered; any other path stays as plain text. Never invent a path, and do not claim an image is shown unless you wrote that line.\n";

/// Title each chat from the user's message, with no model call.
///
/// The desktop composer uses the same rules in `sessionTitleFromMessage` so
/// the sidebar can update before this turn reaches the provider. Keep the two
/// in step. This local title is the instant provisional one; the model's
/// `GYRO_SESSION_TITLE` line replaces it as soon as that line arrives.
pub(crate) fn session_title_from_message(message: &str) -> Option<String> {
    let without_fences = strip_fenced_code_blocks(&message.replace('\0', ""));
    let without_inline = strip_inline_code_markers(&without_fences);
    let without_command = strip_leading_slash_command(without_inline.trim());
    // A message that opens with a numbered or bulleted list ("1. …", "- …")
    // puts the first `.` inside the list marker, so splitting on sentence
    // punctuation alone yields a title like "1". Walk every fragment and take
    // the first one that still has words once the marker is gone.
    let Some(fragment) = without_command
        .split(|character| matches!(character, '.' | '!' | '?' | '\n'))
        .map(strip_list_marker)
        .map(str::trim)
        .map(strip_title_preamble)
        .find(|fragment| fragment.chars().any(char::is_alphabetic))
    else {
        return None;
    };
    let words = fragment
        .split_whitespace()
        .take(6)
        .map(title_case_word)
        .collect::<Vec<_>>()
        .join(" ");
    sanitize_session_title_candidate(&words)
}

/// Drop a leading list marker so `1. Fix the picker` and `- fix the picker`
/// both start at the words that name the task.
///
/// The sentence split runs before this, so an ordered marker usually arrives
/// with its `.` already consumed ("1") and must still be recognised as a
/// marker rather than as a title.
pub(crate) fn strip_list_marker(text: &str) -> &str {
    let mut rest = text.trim_start();
    loop {
        let trimmed = rest.trim_start();
        // Markdown headings and quotes carry no title content.
        let after_prefix = trimmed
            .trim_start_matches('#')
            .trim_start_matches('>')
            .trim_start();
        rest = after_prefix;
        let mut chars = rest.char_indices();
        match chars.next() {
            Some((index, ch @ ('-' | '*' | '+' | '•'))) => {
                let after = &rest[index + ch.len_utf8()..];
                if after.is_empty() || after.starts_with(char::is_whitespace) {
                    rest = after;
                    continue;
                }
            }
            Some((_, ch)) if ch.is_ascii_digit() => {
                let end = rest
                    .find(|ch: char| !ch.is_ascii_digit())
                    .unwrap_or(rest.len());
                let after = &rest[end..];
                let marked = after.strip_prefix(['.', ')', ':']).unwrap_or(after);
                if marked.len() != after.len() {
                    rest = marked.trim_start();
                    if rest.is_empty() {
                        return "";
                    }
                    continue;
                }
                // A bare number left by the sentence split ("1." became "1")
                // is a marker with its words elsewhere, never a title.
                if after.trim().is_empty() {
                    return "";
                }
                return rest;
            }
            _ => {}
        }
        return rest;
    }
}

pub(crate) fn strip_fenced_code_blocks(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(start) = rest.find("```") {
        out.push_str(&rest[..start]);
        let after = &rest[start + 3..];
        if let Some(end) = after.find("```") {
            out.push(' ');
            rest = &after[end + 3..];
        } else {
            rest = "";
            break;
        }
    }
    out.push_str(rest);
    out
}

pub(crate) fn strip_inline_code_markers(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(start) = rest.find('`') {
        out.push_str(&rest[..start]);
        let after = &rest[start + '`'.len_utf8()..];
        match after.find('`') {
            Some(end) if end > 0 => {
                out.push_str(&after[..end]);
                rest = &after[end + '`'.len_utf8()..];
            }
            _ => {
                out.push('`');
                rest = after;
            }
        }
    }
    out.push_str(rest);
    out
}

pub(crate) fn strip_leading_slash_command(text: &str) -> &str {
    let bytes = text.as_bytes();
    if bytes.first() != Some(&b'/') {
        return text;
    }
    let mut index = 1;
    while index < bytes.len() && (bytes[index].is_ascii_alphanumeric() || bytes[index] == b'_') {
        index += 1;
    }
    if index == 1 {
        return text;
    }
    let rest = &text[index..];
    let trimmed = rest.trim_start();
    if trimmed.len() == rest.len() {
        text
    } else {
        trimmed
    }
}

pub(crate) fn strip_title_preamble(text: &str) -> &str {
    const PREAMBLES: &[&str] = &[
        "please ",
        "can you ",
        "could you ",
        "would you ",
        "i want to ",
        "i need to ",
        "help me ",
        "let's ",
        "lets ",
    ];
    let lower = text.to_lowercase();
    for preamble in PREAMBLES {
        if lower.starts_with(preamble) {
            return text.get(preamble.len()..).unwrap_or(text).trim();
        }
    }
    text
}

pub(crate) fn title_case_word(word: &str) -> String {
    let acronym = word.len() >= 2
        && word
            .chars()
            .all(|character| character.is_ascii_uppercase() || character.is_ascii_digit());
    if acronym {
        return word.to_string();
    }
    let mut characters = word.chars();
    let Some(first) = characters.next() else {
        return String::new();
    };
    let mut titled = first.to_uppercase().collect::<String>();
    titled.extend(characters);
    titled
}
