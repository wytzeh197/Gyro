use crate::app::limits::{MAX_CHAT_MESSAGE_CHARS, MAX_CHAT_RESPONSE_CHARS, TEXT_TRUNCATION_SUFFIX};
pub(crate) fn validate_chat_message(message: &str) -> Result<String, String> {
    let message = message.replace('\0', "").trim().to_string();
    if message.is_empty() {
        return Err("chat message is required".into());
    }
    if message.chars().count() > MAX_CHAT_MESSAGE_CHARS {
        return Err(format!(
            "chat message cannot exceed {MAX_CHAT_MESSAGE_CHARS} characters"
        ));
    }
    Ok(message)
}

pub(crate) fn chat_message_preview(message: &str) -> String {
    let normalized = message.split_whitespace().collect::<Vec<_>>().join(" ");
    truncate_chars(&normalized, 160)
}

pub(crate) fn sanitize_provider_chat_response(response: &str) -> String {
    let redacted = gyro_core::security::redact_secrets(response.trim());
    truncate_chars(&redacted, MAX_CHAT_RESPONSE_CHARS)
}

pub(crate) fn sanitize_provider_text_delta(delta: &str) -> String {
    // A delta is redacted but never clipped: chunk boundaries are arbitrary, so
    // a per-chunk limit cuts mid-sentence and, at 64k, silently truncated any
    // long answer long before the accumulator saw it.
    gyro_core::security::redact_secrets(delta)
}

pub(crate) fn truncate_error_detail(value: &str) -> String {
    const MAX_ERROR_DETAIL_CHARS: usize = 4_000;
    truncate_chars(value, MAX_ERROR_DETAIL_CHARS)
}

pub(crate) fn truncate_chars(value: &str, max_chars: usize) -> String {
    if value.len() <= max_chars {
        return value.to_string();
    }
    let Some((truncate_at, _)) = value.char_indices().nth(max_chars) else {
        return value.to_string();
    };
    format!("{}{}", &value[..truncate_at], TEXT_TRUNCATION_SUFFIX)
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub(crate) struct BoundedPushResult {
    pub(crate) accepted_chars: usize,
    pub(crate) truncated: bool,
}

pub(crate) fn push_bounded(
    target: &mut String,
    target_chars: &mut usize,
    value: &str,
    max_chars: usize,
) -> BoundedPushResult {
    if value.is_empty() {
        return BoundedPushResult::default();
    }
    let remaining_chars = max_chars.saturating_sub(*target_chars);
    if remaining_chars == 0 {
        // One ellipsis marks the cut; appending it on every later delta would
        // bury the message under its own suffix.
        if !target.ends_with(TEXT_TRUNCATION_SUFFIX) {
            target.push_str(TEXT_TRUNCATION_SUFFIX);
        }
        return BoundedPushResult {
            accepted_chars: 0,
            truncated: true,
        };
    }
    let value_chars = value.chars().count();
    if value_chars <= remaining_chars {
        target.push_str(value);
        *target_chars += value_chars;
        return BoundedPushResult {
            accepted_chars: value_chars,
            truncated: false,
        };
    }

    target.extend(value.chars().take(remaining_chars));
    target.push_str(TEXT_TRUNCATION_SUFFIX);
    *target_chars += remaining_chars;
    BoundedPushResult {
        accepted_chars: remaining_chars,
        truncated: true,
    }
}
