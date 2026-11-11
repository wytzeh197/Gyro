//! Providers chat_types.

use crate::{
    app::limits::MAX_CHAT_VIDEO_BYTES, efficiency, providers::types::ProviderResumeCursor,
};
use gyro_core::{Session, SessionEvent};
use serde::{Deserialize, Serialize};

/// The purpose that shapes this request's prompt, unless rolled back.
pub(crate) fn isolated_internal_purpose(
    request: &ProviderChatRequest,
) -> Option<InternalRequestPurpose> {
    request.internal_purpose.filter(|purpose| {
        matches!(
            purpose,
            InternalRequestPurpose::CodeReview | InternalRequestPurpose::WorkflowExtraction
        ) || !efficiency::config().full_context_internal_requests
    })
}

/// Promote an explicit planning request made in Normal chat to the real Plan
/// mode. This is deliberately narrower than a raw `contains("plan")`: talking
/// about, implementing, or rejecting an existing plan must not silently turn a
/// mutating request into a read-only turn.
pub(crate) fn normal_chat_requests_plan(message: &str) -> bool {
    let words = message
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
        .map(str::to_string)
        .collect::<Vec<_>>();
    if !words
        .iter()
        .any(|word| matches!(word.as_str(), "plan" | "planning"))
    {
        return false;
    }
    let normalized = words.join(" ");
    let declines_planning = [
        "do not make a plan",
        "don t make a plan",
        "dont make a plan",
        "do not plan",
        "don t plan",
        "dont plan",
        "without a plan",
        "skip the plan",
        "avoid making a plan",
        "no plan needed",
    ]
    .iter()
    .any(|phrase| normalized.contains(phrase));
    let requests_execution = [
        "implement the plan",
        "implement this plan",
        "implement our plan",
        "execute the plan",
        "execute this plan",
        "follow the plan",
        "follow this plan",
        "carry out the plan",
        "carry out this plan",
        "work through the plan",
        "start implementing the plan",
        "continue implementing the plan",
    ]
    .iter()
    .any(|phrase| normalized.contains(phrase));
    if declines_planning || requests_execution {
        return false;
    }

    let explicit_phrases = [
        "make a plan",
        "create a plan",
        "draft a plan",
        "write a plan",
        "outline a plan",
        "prepare a plan",
        "propose a plan",
        "develop a plan",
        "put together a plan",
        "come up with a plan",
        "get started on a plan",
        "start on a plan",
        "give me a plan",
        "give us a plan",
        "show me a plan",
        "show us a plan",
        "help me plan",
        "help us plan",
        "can you plan",
        "could you plan",
        "would you plan",
        "please plan",
        "what is the plan",
        "what s the plan",
        "what do you plan",
    ];
    if explicit_phrases
        .iter()
        .any(|phrase| normalized.contains(phrase))
    {
        return true;
    }

    const PLANNING_ACTIONS: &[&str] = &[
        "make", "create", "draft", "write", "outline", "prepare", "propose", "develop", "start",
        "started", "begin", "revise", "refine", "rework",
    ];
    for (plan_index, word) in words.iter().enumerate() {
        if !matches!(word.as_str(), "plan" | "planning") {
            continue;
        }
        let window_start = plan_index.saturating_sub(5);
        let prior = &words[window_start..plan_index];
        if prior.iter().enumerate().any(|(offset, candidate)| {
            if !PLANNING_ACTIONS.contains(&candidate.as_str()) {
                return false;
            }
            // "Make sure the plan…" is an instruction about behavior, not a
            // request to create a plan.
            candidate != "make" || prior.get(offset + 1).map(String::as_str) != Some("sure")
        }) {
            return true;
        }
        if (word == "planning"
            || prior
                .iter()
                .any(|candidate| matches!(candidate.as_str(), "a" | "an")))
            && prior
                .iter()
                .any(|candidate| matches!(candidate.as_str(), "need" | "want"))
        {
            return true;
        }
        if plan_index == 0
            && words.get(1).is_some_and(|next| {
                matches!(next.as_str(), "a" | "an" | "how" | "for" | "to" | "out")
            })
        {
            return true;
        }
    }
    false
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PrepareChatAttachmentRequest {
    pub(crate) session_id: String,
    pub(crate) path: String,
    pub(crate) workspace_path: Option<String>,
    pub(crate) kind: String,
    #[serde(default, deserialize_with = "deserialize_optional_attachment_bytes")]
    pub(crate) bytes: Option<Vec<u8>>,
    pub(crate) name: Option<String>,
    pub(crate) relative_path: Option<String>,
}

pub(crate) fn deserialize_optional_attachment_bytes<'de, D>(
    deserializer: D,
) -> Result<Option<Vec<u8>>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    struct OptionalBytesVisitor;

    impl<'de> serde::de::Visitor<'de> for OptionalBytesVisitor {
        type Value = Option<Vec<u8>>;

        fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            formatter.write_str("an optional bounded byte array")
        }

        fn visit_none<E>(self) -> Result<Self::Value, E> {
            Ok(None)
        }

        fn visit_unit<E>(self) -> Result<Self::Value, E> {
            Ok(None)
        }

        fn visit_some<D2>(self, deserializer: D2) -> Result<Self::Value, D2::Error>
        where
            D2: serde::Deserializer<'de>,
        {
            deserializer.deserialize_seq(BoundedBytesVisitor).map(Some)
        }
    }

    struct BoundedBytesVisitor;

    impl<'de> serde::de::Visitor<'de> for BoundedBytesVisitor {
        type Value = Vec<u8>;

        fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            write!(formatter, "at most {MAX_CHAT_VIDEO_BYTES} media bytes")
        }

        fn visit_seq<A>(self, mut sequence: A) -> Result<Self::Value, A::Error>
        where
            A: serde::de::SeqAccess<'de>,
        {
            let limit = MAX_CHAT_VIDEO_BYTES as usize;
            let mut bytes = Vec::with_capacity(sequence.size_hint().unwrap_or(0).min(limit));
            while let Some(byte) = sequence.next_element::<u8>()? {
                if bytes.len() >= limit {
                    return Err(serde::de::Error::custom(format!(
                        "media attachment exceeds the {} MB limit",
                        MAX_CHAT_VIDEO_BYTES / (1024 * 1024)
                    )));
                }
                bytes.push(byte);
            }
            Ok(bytes)
        }
    }

    deserializer.deserialize_option(OptionalBytesVisitor)
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PreparedChatAttachment {
    pub(crate) id: String,
    pub(crate) kind: String,
    pub(crate) name: String,
    pub(crate) path: String,
    pub(crate) relative_path: Option<String>,
    pub(crate) mime_type: Option<String>,
    pub(crate) size: u64,
    pub(crate) content_hash: String,
    pub(crate) modified_at: Option<String>,
    pub(crate) available: bool,
    pub(crate) stale: bool,
    /// The stored text of a terminal-output attachment, after redaction, so
    /// the composer can preview exactly what the model will receive.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) preview_text: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProviderChatResponse {
    pub(crate) activity_events: Vec<SessionEvent>,
    pub(crate) assistant_event: SessionEvent,
    pub(crate) session: Option<Session>,
    pub(crate) session_title: Option<String>,
    pub(crate) status_event: SessionEvent,
    pub(crate) resume_cursor: Option<ProviderResumeCursor>,
}

/// Manual context compaction is a provider operation, not a synthetic chat
/// message. The response only returns the durable activity rows; the live
/// status travels through the normal provider activity stream.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProviderContextCompactionResponse {
    pub(crate) activity_events: Vec<SessionEvent>,
}

pub(crate) use gyro_core::provider_runtime::types::{
    ChatAttachmentRequest, ChatMode, InternalRequestPurpose, ProviderChatRequest,
    SessionGoalContext,
};
