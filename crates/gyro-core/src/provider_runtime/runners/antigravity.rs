use crate::provider_runtime::{
    host::RunnerHost,
    runners::kimi_acp::run_kimi_acp_chat,
    types::{ProviderChatRequest, ProviderResumeCursor, ProviderRunAttempt, ProviderRunnerOutput},
};

/// Google Antigravity through Google's official ACP server.
///
/// The process is unmodified `agy acp`. Gyro does not wrap `agy -p` or add
/// print-mode flags. Only Gemini model ids are sent; anything else stops
/// before the CLI starts.
pub fn run_antigravity_chat(
    host: &dyn RunnerHost,
    request: &ProviderChatRequest,
    resume_cursor: Option<&ProviderResumeCursor>,
    attempt: &mut ProviderRunAttempt,
) -> anyhow::Result<ProviderRunnerOutput> {
    ensure_antigravity_gemini_model(request.model_id.as_deref())?;
    run_kimi_acp_chat(host, request, resume_cursor, attempt)
}

/// Refuse a turn whose model is not a Gemini id.
///
/// Antigravity's catalog also lists Claude, GPT, and an "Automatic" default.
/// Those stay out of this runner. An empty selection is refused the same way,
/// because the CLI default is not guaranteed to be a Gemini model.
pub fn ensure_antigravity_gemini_model(model_id: Option<&str>) -> anyhow::Result<()> {
    let Some(id) = model_id.map(str::trim).filter(|id| !id.is_empty()) else {
        anyhow::bail!("Antigravity in Gyro runs Gemini models only. Pick a Gemini model.");
    };
    if is_antigravity_gemini_model(id) {
        return Ok(());
    }
    anyhow::bail!("Antigravity in Gyro runs Gemini models only. `{id}` is not a Gemini model.")
}

/// True when the id is a Gemini model, including a vendor prefix (`google/…`).
pub fn is_antigravity_gemini_model(model_id: &str) -> bool {
    let leaf = model_id
        .trim()
        .rsplit(['/', ':'])
        .next()
        .unwrap_or(model_id)
        .trim()
        .to_ascii_lowercase();
    (leaf == "gemini" || leaf.starts_with("gemini-"))
        && !leaf.ends_with("-default")
        && !leaf.contains("claude")
        && !leaf.starts_with("gpt")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_gemini_models_run() {
        assert!(is_antigravity_gemini_model("gemini-3.1-pro-preview"));
        assert!(is_antigravity_gemini_model("gemini-4-neon-xhigh"));
        assert!(is_antigravity_gemini_model("google/gemini-3.8-flash"));
        assert!(!is_antigravity_gemini_model("antigravity-default"));
        assert!(!is_antigravity_gemini_model("gemini-default"));
        assert!(!is_antigravity_gemini_model("claude-sonnet-4-6"));
        assert!(!is_antigravity_gemini_model("gpt-oss-120b"));
        assert!(!is_antigravity_gemini_model("Orchestrator (Neon)"));
        assert!(ensure_antigravity_gemini_model(Some("gemini-3.8-flash")).is_ok());
        let rejected = ensure_antigravity_gemini_model(Some("claude-opus-4-6"))
            .unwrap_err()
            .to_string();
        assert!(rejected.contains("Gemini models only"));
        assert!(ensure_antigravity_gemini_model(None).is_err());
        assert!(ensure_antigravity_gemini_model(Some("antigravity-default")).is_err());
    }
}
