//! Numeric observations of generation requests and native provider attempts. The collector follows a
//! blocking turn worker and survives error paths; it never retains request text.
use crate::{timing, UsageTokens};
use serde::Serialize;
use serde_json::Value;
use std::cell::RefCell;

thread_local! { static ACTIVE: RefCell<Option<Summary>> = const { RefCell::new(None) }; }

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    pub requests: u32,
    pub completed: u32,
    pub rejected: u32,
    pub retries: u32,
    pub tokens: Option<UsageTokens>,
    /// Images and provider-owned context cannot be priced from JSON characters.
    pub unmeasured_content: bool,
    pub provider_attempts: u32,
    #[serde(skip)]
    native: NativeAttempt,
    #[serde(skip)]
    previous_native: Option<UsageTokens>,
}

#[derive(Clone, Debug, Default)]
struct NativeAttempt {
    prompt_chars: usize,
    output_chars: usize,
    reported: Option<UsageTokens>,
}
impl NativeAttempt {
    fn tokens(&self) -> Option<UsageTokens> {
        self.reported.or_else(|| {
            (self.prompt_chars > 0 || self.output_chars > 0)
                .then(|| UsageTokens::estimated(self.prompt_chars, self.output_chars))
        })
    }
}
pub fn attempt() {
    ACTIVE.with(|slot| {
        if let Some(summary) = slot.borrow_mut().as_mut() {
            if summary.provider_attempts > 0 {
                summary.retries += 1;
            }
            summary.provider_attempts += 1;
            if let Some(tokens) = summary.native.tokens() {
                add_usage(&mut summary.previous_native, tokens);
            }
            summary.native = NativeAttempt::default();
        }
    });
}
/// Only the prompt actually dispatched to the native agent belongs here.
/// Its own history, schemas and internal tool loops remain provider-owned.
pub fn native_prompt(payload: &Value) {
    ACTIVE.with(|slot| {
        if let Some(summary) = slot.borrow_mut().as_mut() {
            summary.native.prompt_chars = text_size(payload).0;
        }
    });
}
pub fn native_delta(text: &str) {
    ACTIVE.with(|slot| {
        if let Some(summary) = slot.borrow_mut().as_mut() {
            summary.native.output_chars = summary
                .native
                .output_chars
                .saturating_add(text.chars().count());
        }
    });
}
pub fn native_usage(tokens: UsageTokens) {
    // An explicit zero is still a reading, not permission to estimate a prompt.
    ACTIVE.with(|slot| {
        if let Some(summary) = slot.borrow_mut().as_mut() {
            summary.native.reported = Some(tokens);
        }
    });
}
pub struct Scope(Option<Summary>);
impl Scope {
    pub fn start() -> Self {
        Self(ACTIVE.with(|slot| slot.replace(Some(Summary::default()))))
    }
}
impl Drop for Scope {
    fn drop(&mut self) {
        ACTIVE.with(|slot| slot.replace(self.0.take()));
    }
}
pub fn snapshot() -> Option<Summary> {
    ACTIVE.with(|slot| {
        slot.borrow().clone().map(|mut summary| {
            if summary.requests == 0 {
                summary.tokens = summary.previous_native;
                if let Some(tokens) = summary.native.tokens() {
                    add_usage(&mut summary.tokens, tokens);
                }
                summary.unmeasured_content = summary.tokens.is_some_and(|tokens| !tokens.measured);
            } else if summary.requests == summary.rejected && summary.tokens.is_none() {
                // No generation was observed. Keep this explicit so the ledger
                // does not fall back to charging an estimate of the user prompt.
                summary.tokens = Some(UsageTokens::estimated(0, 0));
            }
            summary
        })
    })
}
pub fn retry() {
    ACTIVE.with(|slot| {
        if let Some(summary) = slot.borrow_mut().as_mut() {
            summary.retries = summary.retries.saturating_add(1);
        }
    });
}

pub struct Request {
    index: u32,
    input_chars: usize,
    output_chars: usize,
    input_tokens: Option<u64>,
    output_tokens: Option<u64>,
    total_tokens: Option<u64>,
    complete: bool,
    rejected: bool,
    unmeasured_content: bool,
    cached: Option<u64>,
    reasoning: Option<u64>,
}
impl Request {
    pub fn start(payload: &Value) -> Self {
        let index = ACTIVE.with(|slot| {
            slot.borrow_mut().as_mut().map_or(0, |summary| {
                summary.requests = summary.requests.saturating_add(1);
                summary.requests
            })
        });
        let (input_chars, unmeasured_content) = text_size(payload);
        timing::request(timing::Stage::RequestStart, index);
        Self {
            index,
            input_chars,
            output_chars: 0,
            input_tokens: None,
            output_tokens: None,
            total_tokens: None,
            complete: false,
            rejected: false,
            unmeasured_content,
            cached: None,
            reasoning: None,
        }
    }
    pub fn delta(&mut self, text: &str) {
        self.output_chars = self.output_chars.saturating_add(text.chars().count());
        if !text.is_empty() {
            timing::mark(timing::Stage::FirstToken);
        }
    }
    pub fn complete(&mut self, input: Option<u64>, output: Option<u64>, output_chars: usize) {
        self.complete = true;
        self.output_chars = self.output_chars.max(output_chars);
        self.reported(input, output);
    }
    pub fn details(&mut self, cached: Option<u64>, reasoning: Option<u64>) {
        self.cached = cached.or(self.cached);
        self.reasoning = reasoning.or(self.reasoning);
    }
    pub fn reported(&mut self, input: Option<u64>, output: Option<u64>) {
        // Providers may send the two sides in separate frames. Fill any missing
        // side only at the end, after all observable output has arrived.
        self.input_tokens = input.or(self.input_tokens);
        self.output_tokens = output.or(self.output_tokens);
    }
    pub fn reported_total(&mut self, total: Option<u64>) {
        self.total_tokens = total.or(self.total_tokens);
    }
    pub fn rejected(&mut self) {
        self.rejected = true;
    }
}
impl Drop for Request {
    fn drop(&mut self) {
        timing::request(timing::Stage::RequestEnd, self.index);
        ACTIVE.with(|slot| {
            let mut slot = slot.borrow_mut();
            let Some(summary) = slot.as_mut() else { return };
            summary.completed += u32::from(self.complete);
            summary.rejected += u32::from(self.rejected);
            if self.rejected {
                return;
            }
            let estimate = UsageTokens::estimated(self.input_chars, self.output_chars);
            // A reported total wins over character estimates of missing halves.
            // Infer a missing side only when subtraction is well-defined.
            let input = self
                .input_tokens
                .or_else(|| self.total_tokens?.checked_sub(self.output_tokens?));
            let output = self
                .output_tokens
                .or_else(|| self.total_tokens?.checked_sub(self.input_tokens?));
            let mut tokens = UsageTokens::measured(
                input.or_else(|| self.total_tokens.is_none().then_some(estimate.input_tokens)),
                self.cached,
                output.or_else(|| {
                    self.total_tokens
                        .is_none()
                        .then_some(estimate.output_tokens)
                }),
                self.reasoning,
                self.total_tokens,
            );
            tokens.measured &= self.complete
                && (self.total_tokens.is_some()
                    || (self.input_tokens.is_some() && self.output_tokens.is_some()));
            summary.unmeasured_content |= self.unmeasured_content && !tokens.measured;
            add_usage(&mut summary.tokens, tokens);
        });
    }
}

pub fn add_usage(total: &mut Option<UsageTokens>, tokens: UsageTokens) {
    if let Some(total) = total {
        total.input_tokens = total.input_tokens.saturating_add(tokens.input_tokens);
        total.cached_input_tokens = total
            .cached_input_tokens
            .saturating_add(tokens.cached_input_tokens);
        total.output_tokens = total.output_tokens.saturating_add(tokens.output_tokens);
        total.reasoning_output_tokens = total
            .reasoning_output_tokens
            .saturating_add(tokens.reasoning_output_tokens);
        total.total_tokens = total.total_tokens.saturating_add(tokens.total_tokens);
        total.measured &= tokens.measured;
    } else {
        *total = Some(tokens);
    }
}

// Count text and schema structure without serializing or cloning large images.
// Image bytes are not text tokens and must not become fictitious token spend.
pub(crate) fn text_size(value: &Value) -> (usize, bool) {
    match value {
        Value::String(text) if text.starts_with("data:image/") => (0, true),
        Value::String(text) => (text.chars().count().saturating_add(2), false),
        Value::Array(items) => items
            .iter()
            .map(text_size)
            .fold((2, false), |(n, u), (s, v)| {
                (n.saturating_add(s + 1), u || v)
            }),
        Value::Object(fields) => fields.iter().fold((2usize, false), |(n, u), (key, value)| {
            let (size, unknown) = if matches!(key.as_str(), "images" | "image_url")
                || (matches!(key.as_str(), "data" | "blob")
                    && fields.get("type").and_then(Value::as_str) == Some("image"))
            {
                (0, true)
            } else {
                text_size(value)
            };
            (
                n.saturating_add(key.len() + 4).saturating_add(size),
                u || unknown,
            )
        }),
        _ => (value.to_string().len(), false),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn explicit_zero_native_usage_survives_prompt_estimation_and_retries() {
        let _scope = Scope::start();
        attempt();
        native_prompt(&serde_json::json!("x".repeat(4000)));
        native_usage(UsageTokens::measured(Some(0), None, Some(0), None, Some(0)));
        let zero = snapshot().unwrap().tokens.unwrap();
        assert_eq!(zero.total_tokens, 0);
        assert!(zero.measured);
        attempt();
        native_usage(UsageTokens::measured(Some(10), None, Some(5), None, None));
        assert_eq!(snapshot().unwrap().tokens.unwrap().total_tokens, 15);
    }

    #[test]
    fn reported_totals_survive_partial_duplicate_and_total_only_frames() {
        for (input, output) in [(Some(100), Some(20)), (Some(100), None), (None, None)] {
            let _scope = Scope::start();
            {
                let mut request = Request::start(&serde_json::json!("x".repeat(80_000)));
                request.reported(input, output);
                request.reported_total(Some(150));
                request.reported_total(Some(150));
                request.complete(None, None, 4000);
            }
            let tokens = snapshot().unwrap().tokens.unwrap();
            assert_eq!(tokens.total_tokens, 150);
            assert!(tokens.measured);
        }
    }

    #[test]
    fn mixed_rounds_and_failed_requests_keep_spend_without_claiming_measurement() {
        let _scope = Scope::start();
        {
            let mut request =
                Request::start(&serde_json::json!({"messages": ["instructions", "tool result"]}));
            request.complete(Some(100), Some(20), 80);
        }
        {
            let mut request = Request::start(
                &serde_json::json!({"messages": ["instructions", "tool result", "more context"]}),
            );
            request.delta("partial answer");
        }
        let summary = snapshot().unwrap();
        assert_eq!((summary.requests, summary.completed), (2, 1));
        let tokens = summary.tokens.unwrap();
        assert!(tokens.input_tokens > 100 && tokens.output_tokens > 20);
        assert!(!tokens.measured);
    }
    #[test]
    fn rejected_requests_and_image_bytes_do_not_inflate_usage() {
        let _scope = Scope::start();
        {
            let mut request = Request::start(&serde_json::json!({"messages": "bad request"}));
            request.rejected();
        }
        let rejected = snapshot().unwrap().tokens.unwrap();
        assert!(rejected.is_empty() && !rejected.measured);
        {
            let _request = Request::start(&serde_json::json!({"images": ["x".repeat(100_000)]}));
        }
        let summary = snapshot().unwrap();
        assert!(summary.tokens.unwrap().total_tokens < 20);
        assert!(summary.unmeasured_content);
        assert!(!serde_json::to_string(&summary)
            .unwrap()
            .contains("bad request"));
        let (chars, unknown) = text_size(&serde_json::json!({
            "type": "image", "data": "x".repeat(100_000), "mimeType": "image/png"
        }));
        assert!(unknown && chars < 100);
    }
    #[test]
    fn native_restarts_keep_prior_attempts_and_reported_cache_counts() {
        let _scope = Scope::start();
        attempt();
        native_prompt(&serde_json::json!("first dispatched prompt"));
        native_delta("partial answer");
        let first = snapshot().unwrap().tokens.unwrap();
        attempt();
        native_prompt(&serde_json::json!("retry dispatched prompt"));
        let measured = UsageTokens::measured(Some(100), Some(80), Some(25), Some(10), None);
        native_usage(measured);
        native_usage(measured);
        let summary = snapshot().unwrap();
        let tokens = summary.tokens.unwrap();
        assert_eq!(tokens.total_tokens, first.total_tokens + 125);
        assert_eq!(
            (tokens.cached_input_tokens, tokens.reasoning_output_tokens),
            (80, 10)
        );
        assert!(!tokens.measured);
        assert_eq!((summary.provider_attempts, summary.retries), (2, 1));
        assert!(summary.unmeasured_content);
    }
    #[test]
    fn partial_usage_frames_keep_both_sides_and_estimate_the_latest_output() {
        for finished in [false, true] {
            let _scope = Scope::start();
            {
                let mut request = Request::start(&serde_json::json!({"messages": "prompt"}));
                request.reported(Some(100), None);
                request.delta(&"a".repeat(80));
                request.details(Some(60), Some(5));
                if finished {
                    request.complete(None, Some(30), 80);
                }
            }
            let tokens = snapshot().unwrap().tokens.unwrap();
            assert_eq!(tokens.input_tokens, 100);
            assert_eq!(tokens.output_tokens, if finished { 30 } else { 20 });
            assert_eq!(tokens.cached_input_tokens, 60);
            assert_eq!(tokens.reasoning_output_tokens, 5);
            assert_eq!(tokens.measured, finished);
        }
    }
}
