use crate::{
    browser::types::{
        BrowserObservation, BrowserObservationDiagnostics, BrowserObservationEvidence,
        BrowserObservationOwner, BrowserPreviewCapture, BROWSER_OBSERVATION_FRAMING,
        BROWSER_OBSERVATION_SCHEMA_V1,
    },
    ide::types::TaskDefinitionResult,
    session_browser,
    state::{
        managers::ProviderCapabilityResourceManager,
        provider_run::{BoundProviderCapabilityContext, ModelBrowserResource},
    },
    subagent_capability,
};
use gyro_core::{
    CapabilityAccess, CapabilityClass, CapabilityId, CapabilityRunMode, GyroConfig,
    ProjectCapabilityPolicy,
};
use sha2::{Digest, Sha256};
use std::path::Path;
use tauri::Manager;
use uuid::Uuid;
pub(crate) fn capability_argument_string<'a>(
    arguments: &'a serde_json::Value,
    name: &str,
) -> anyhow::Result<&'a str> {
    arguments
        .get(name)
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| anyhow::anyhow!("capability argument `{name}` is required"))
}

pub(crate) fn capability_argument_u64(
    arguments: &serde_json::Value,
    name: &str,
) -> anyhow::Result<u64> {
    arguments
        .get(name)
        .and_then(|value| {
            value.as_u64().or_else(|| {
                // Providers that emit every argument as a string still need to
                // be able to name a run id.
                value.as_str().and_then(|value| value.trim().parse().ok())
            })
        })
        .ok_or_else(|| anyhow::anyhow!("capability argument `{name}` must be a positive number"))
}

pub(crate) fn capability_argument_usize(
    arguments: &serde_json::Value,
    name: &str,
) -> Option<usize> {
    capability_argument_u64(arguments, name)
        .ok()
        .map(|value| value.clamp(1, 50) as usize)
}

pub(crate) fn capability_argument_strings(
    arguments: &serde_json::Value,
    name: &str,
) -> anyhow::Result<Vec<String>> {
    let values = arguments
        .get(name)
        .and_then(serde_json::Value::as_array)
        .cloned()
        .unwrap_or_default();
    if values.len() > 64 {
        anyhow::bail!("capability argument `{name}` has too many values");
    }
    values
        .into_iter()
        .map(|value| {
            let value = value
                .as_str()
                .ok_or_else(|| anyhow::anyhow!("capability argument `{name}` must be text"))?;
            if value.contains('\0') || value.chars().count() > 4_096 {
                anyhow::bail!("capability argument `{name}` is invalid");
            }
            Ok(value.to_string())
        })
        .collect()
}

pub(crate) fn capability_positive_position(
    arguments: &serde_json::Value,
    name: &str,
) -> anyhow::Result<Option<u64>> {
    let Some(value) = arguments.get(name) else {
        return Ok(None);
    };
    let value = value
        .as_u64()
        .filter(|value| (1..=10_000_000).contains(value))
        .ok_or_else(|| {
            anyhow::anyhow!("capability argument `{name}` must be a positive integer")
        })?;
    Ok(Some(value))
}

pub(crate) fn capability_path_is_sensitive_in_workspace(
    workspace: &Path,
    path: &str,
) -> anyhow::Result<bool> {
    if gyro_core::capability_path_is_sensitive(path) {
        return Ok(true);
    }
    let workspace = workspace.canonicalize()?;
    let candidate = gyro_core::security::assert_path_inside_workspace(&workspace, Path::new(path))?;
    let relative = candidate.strip_prefix(&workspace)?;
    Ok(gyro_core::capability_path_is_sensitive(
        &relative.to_string_lossy(),
    ))
}

pub(crate) fn effective_capability_class(
    workspace: &Path,
    capability_id: CapabilityId,
    arguments: &serde_json::Value,
) -> anyhow::Result<CapabilityClass> {
    if capability_id == CapabilityId::ResearchRun
        && subagent_capability::retrieves_existing(arguments)
    {
        return Ok(CapabilityClass::WorkspaceInspect);
    }
    if matches!(
        capability_id,
        CapabilityId::WorkspaceRead
            | CapabilityId::WorkspaceReadRange
            | CapabilityId::WorkspaceReadEditor
            | CapabilityId::CodeDefinition
            | CapabilityId::CodeReferences
            | CapabilityId::CodeHover
            | CapabilityId::CodeSymbols
            | CapabilityId::WorkspaceGitBlame
            | CapabilityId::WorkspaceGitShow
            | CapabilityId::WorkspaceGitLog
    ) {
        let path = gyro_core::normalize_capability_relative_path(capability_argument_string(
            arguments, "path",
        )?)?;
        // Classify the resolved target as well as the requested name. An
        // ordinary-looking symlink must not bypass sensitive-read approval.
        if capability_path_is_sensitive_in_workspace(workspace, &path)? {
            return Ok(CapabilityClass::WorkspaceSensitiveRead);
        }
    }
    if capability_id == CapabilityId::WorkspaceDiff {
        let path = capability_git_diff_path(arguments)?;
        if path
            .as_deref()
            .map(|path| capability_path_is_sensitive_in_workspace(workspace, path))
            .transpose()?
            .unwrap_or(true)
        {
            return Ok(CapabilityClass::WorkspaceSensitiveRead);
        }
    }
    Ok(gyro_core::capability_descriptor(capability_id).class)
}

/// Models cannot list Workspace tasks, so an unknown id names the valid ones
/// instead of leaving the model to guess again.
pub(crate) fn unknown_workspace_task_message(
    task_id: &str,
    tasks: &[TaskDefinitionResult],
    tests_only: bool,
) -> String {
    const MAX_LISTED_IDS_CHARS: usize = 2_000;
    let kind = if tests_only { "test task" } else { "task" };
    let candidates: Vec<&str> = tasks
        .iter()
        .filter(|task| !tests_only || task.group == "test")
        .map(|task| task.id.as_str())
        .collect();
    if candidates.is_empty() {
        return format!(
            "no {kind} with id \"{task_id}\"; this Workspace has no discovered {kind}s"
        );
    }
    let mut listed = String::new();
    let mut shown = 0;
    for id in &candidates {
        let separator = if listed.is_empty() { "" } else { ", " };
        if listed.len() + separator.len() + id.len() > MAX_LISTED_IDS_CHARS {
            break;
        }
        listed.push_str(separator);
        listed.push_str(id);
        shown += 1;
    }
    let more = candidates.len() - shown;
    let suffix = if more > 0 {
        format!(" (and {more} more)")
    } else {
        String::new()
    };
    format!("no {kind} with id \"{task_id}\"; available ids: {listed}{suffix}")
}

pub(crate) fn capability_git_diff_path(
    arguments: &serde_json::Value,
) -> anyhow::Result<Option<String>> {
    let path = arguments
        .get("path")
        .and_then(serde_json::Value::as_str)
        .map(gyro_core::normalize_capability_relative_path)
        .transpose()?;
    if path.as_deref().is_some_and(|path| {
        path.starts_with(':') || path.chars().any(|character| "*?[]".contains(character))
    }) {
        anyhow::bail!("workspace diff requires one exact relative path");
    }
    Ok(path)
}

pub(crate) fn require_model_browser_resource(
    app: &tauri::AppHandle,
    bound: &BoundProviderCapabilityContext,
) -> anyhow::Result<ModelBrowserResource> {
    // Prefer the live session webview; fall back to the legacy resource map.
    if let Ok(snapshot) = app
        .state::<session_browser::SessionBrowserManager>()
        .require_owned(&bound.session_id, &bound.workspace_key)
    {
        session_browser::bind_model_resource(&snapshot.resource_id).map_err(anyhow::Error::msg)?;
        let resources = app.state::<ProviderCapabilityResourceManager>();
        let mut browsers = resources
            .browsers
            .lock()
            .map_err(|_| anyhow::anyhow!("browser capability state is unavailable"))?;
        let resource =
            browsers
                .entry(bound.session_id.clone())
                .or_insert_with(|| ModelBrowserResource {
                    resource_id: snapshot.resource_id.clone(),
                    session_id: bound.session_id.clone(),
                    turn_id: bound.turn_id.clone(),
                    call_id: Uuid::new_v4(),
                    workspace_key: bound.workspace_key.clone(),
                    url: snapshot.url.clone(),
                });
        resource.url = snapshot.url.clone();
        resource.resource_id = snapshot.resource_id.clone();
        return Ok(resource.clone());
    }
    let resources = app.state::<ProviderCapabilityResourceManager>();
    let owned = resources
        .browsers
        .lock()
        .map_err(|_| anyhow::anyhow!("browser capability state is unavailable"))?
        .get(&bound.session_id)
        .cloned()
        .ok_or_else(|| anyhow::anyhow!("this chat has no open browser"))?;
    if owned.workspace_key != bound.workspace_key || owned.session_id != bound.session_id {
        anyhow::bail!("browser resource ownership changed");
    }
    Ok(owned)
}

pub(crate) fn browser_observation(
    app: &tauri::AppHandle,
    owned: &ModelBrowserResource,
    status: &serde_json::Value,
    page: Option<serde_json::Value>,
    screenshot: Option<BrowserPreviewCapture>,
    console: Vec<session_browser::BrowserConsoleEntry>,
    network: Vec<session_browser::BrowserNetworkEntry>,
) -> anyhow::Result<BrowserObservation> {
    let snapshot = app
        .state::<session_browser::SessionBrowserManager>()
        .get_snapshot(&owned.session_id)
        .map_err(anyhow::Error::msg)?
        .ok_or_else(|| anyhow::anyhow!("browser closed while observing the page"))?;
    if snapshot.resource_id != owned.resource_id {
        anyhow::bail!(
            "browser resource changed while observing the page; observe the current browser again"
        );
    }
    if !snapshot.document_committed
        || status
            .pointer("/navigation/id")
            .and_then(serde_json::Value::as_u64)
            != Some(snapshot.navigation_id)
    {
        anyhow::bail!(
            "browser document changed while observing the page; observe the current document again"
        );
    }
    let url = status
        .get("url")
        .and_then(serde_json::Value::as_str)
        .unwrap_or(&owned.url)
        .to_string();
    let title = status
        .get("title")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default()
        .to_string();
    let structured_page = page.is_some();
    let screenshot_captured = screenshot.is_some();
    Ok(BrowserObservation {
        schema: BROWSER_OBSERVATION_SCHEMA_V1,
        observed_at: chrono::Utc::now()
            .to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        resource_id: owned.resource_id.clone(),
        owner: BrowserObservationOwner {
            session_id: owned.session_id.clone(),
            turn_id: owned.turn_id.clone(),
            call_id: owned.call_id,
        },
        url,
        title,
        ready_state: status
            .get("readyState")
            .and_then(serde_json::Value::as_str)
            .map(str::to_string),
        visible: snapshot.visible,
        viewport: status.get("viewport").cloned(),
        history: status.get("history").cloned(),
        page,
        screenshot,
        diagnostics: BrowserObservationDiagnostics { console, network },
        evidence: BrowserObservationEvidence {
            structured_page,
            screenshot_captured,
            // A capture path lets Gyro render evidence for the user, but the
            // provider tools currently receive JSON rather than PNG bytes.
            screenshot_model_visible: false,
            visual_note: screenshot_captured.then(|| {
                "Screenshot saved for the Gyro preview; pixels were not attached to this model turn."
                    .into()
            }),
        },
        framing: BROWSER_OBSERVATION_FRAMING,
    })
}

pub(crate) fn remember_model_browser_resource(
    app: &tauri::AppHandle,
    bound: &BoundProviderCapabilityContext,
    call_id: Uuid,
    snapshot: &session_browser::SessionBrowserSnapshot,
) -> anyhow::Result<()> {
    session_browser::bind_model_resource(&snapshot.resource_id).map_err(anyhow::Error::msg)?;
    let resources = app.state::<ProviderCapabilityResourceManager>();
    let mut browsers = resources
        .browsers
        .lock()
        .map_err(|_| anyhow::anyhow!("browser capability state is unavailable"))?;
    browsers.insert(
        bound.session_id.clone(),
        ModelBrowserResource {
            resource_id: snapshot.resource_id.clone(),
            session_id: bound.session_id.clone(),
            turn_id: bound.turn_id.clone(),
            call_id,
            workspace_key: bound.workspace_key.clone(),
            url: snapshot.url.clone(),
        },
    );
    Ok(())
}

pub(crate) fn browser_capability_origin_scope(
    app: &tauri::AppHandle,
    bound: &BoundProviderCapabilityContext,
) -> anyhow::Result<(String, String)> {
    if let Ok(Some(snapshot)) = app
        .state::<session_browser::SessionBrowserManager>()
        .get_snapshot(&bound.session_id)
    {
        if snapshot.workspace_key != bound.workspace_key {
            anyhow::bail!("browser resource ownership changed");
        }
        let origin = url::Url::parse(&snapshot.url)
            .map(|url| url.origin().ascii_serialization())
            .unwrap_or_else(|_| snapshot.url.clone());
        return Ok(("origin".into(), origin));
    }
    let resources = app.state::<ProviderCapabilityResourceManager>();
    let browsers = resources
        .browsers
        .lock()
        .map_err(|_| anyhow::anyhow!("browser capability state is unavailable"))?;
    let owned = browsers
        .get(&bound.session_id)
        .ok_or_else(|| anyhow::anyhow!("this chat has no open browser"))?;
    if owned.workspace_key != bound.workspace_key || owned.session_id != bound.session_id {
        anyhow::bail!("browser resource ownership changed");
    }
    let origin = url::Url::parse(&owned.url)
        .map(|url| url.origin().ascii_serialization())
        .unwrap_or_else(|_| owned.url.clone());
    Ok(("origin".into(), origin))
}

pub(crate) fn capability_grant_scope(
    capability_id: CapabilityId,
    arguments: &serde_json::Value,
) -> anyhow::Result<(String, String)> {
    match capability_id {
        CapabilityId::WorkspaceRead
        | CapabilityId::WorkspaceReadRange
        | CapabilityId::WorkspaceReadEditor
        | CapabilityId::CodeDefinition
        | CapabilityId::CodeReferences
        | CapabilityId::CodeHover
        | CapabilityId::CodeSymbols
        | CapabilityId::WorkspaceGitBlame
        | CapabilityId::WorkspaceGitShow
        | CapabilityId::WorkspaceGitLog => Ok((
            "path".into(),
            gyro_core::normalize_capability_relative_path(capability_argument_string(
                arguments, "path",
            )?)?,
        )),
        CapabilityId::BrowserOpen | CapabilityId::BrowserNavigate | CapabilityId::WebFetch => {
            let url =
                session_browser::parse_navigable_url(capability_argument_string(arguments, "url")?)
                    .map_err(anyhow::Error::msg)?;
            let origin = url.origin().ascii_serialization();
            Ok(("origin".into(), origin))
        }
        CapabilityId::WorkspaceOpenFolder => Ok((
            "folder".into(),
            capability_argument_string(arguments, "path")?.to_string(),
        )),
        CapabilityId::TerminalOpen => {
            let value = serde_json::json!({
                "program": capability_argument_string(arguments, "program")?,
                "args": capability_argument_strings(arguments, "args")?,
                "cwd": arguments.get("cwd").and_then(serde_json::Value::as_str).unwrap_or("."),
            });
            Ok(("command".into(), serde_json::to_string(&value)?))
        }
        _ => {
            let mut digest = Sha256::new();
            digest.update(serde_json::to_vec(arguments)?);
            Ok((
                "call".into(),
                format!("{}:{:x}", capability_id, digest.finalize()),
            ))
        }
    }
}

pub(crate) fn capability_access_rank(access: CapabilityAccess) -> u8 {
    match access {
        CapabilityAccess::Deny => 0,
        CapabilityAccess::Ask => 1,
        CapabilityAccess::Allow => 2,
    }
}

pub(crate) fn narrower_capability_access(
    first: CapabilityAccess,
    second: CapabilityAccess,
) -> CapabilityAccess {
    if capability_access_rank(first) <= capability_access_rank(second) {
        first
    } else {
        second
    }
}

pub(crate) fn capability_full_access_enabled(config: &GyroConfig) -> bool {
    config.full_access && !config.require_command_approval && !config.require_file_edit_approval
}

pub(crate) fn capability_access_with_full_access(
    bound: &BoundProviderCapabilityContext,
    current: &ProjectCapabilityPolicy,
    class: CapabilityClass,
    scope_kind: &str,
    scope_value: &str,
    full_access: bool,
) -> CapabilityAccess {
    // The composer permission mode is authoritative for normal runs. Plan and
    // Council retain their read-only/advisory contract even with Full access.
    if full_access && bound.policy.mode == CapabilityRunMode::Normal {
        return CapabilityAccess::Allow;
    }
    capability_access_for_call(bound, current, class, scope_kind, scope_value)
}

pub(crate) fn capability_access_for_call(
    bound: &BoundProviderCapabilityContext,
    current: &ProjectCapabilityPolicy,
    class: CapabilityClass,
    scope_kind: &str,
    scope_value: &str,
) -> CapabilityAccess {
    let snapshot_access = bound.policy.access_for(class);
    let mode_denies_access = bound.policy.mode == CapabilityRunMode::Council
        || (bound.policy.mode == CapabilityRunMode::Plan
            && !matches!(
                class,
                CapabilityClass::WorkspaceInspect
                    | CapabilityClass::WorkspaceSensitiveRead
                    | CapabilityClass::IdeReveal
                    | CapabilityClass::BrowserInspect
                    | CapabilityClass::GithubInspect
            ));
    let current_access = if mode_denies_access {
        CapabilityAccess::Deny
    } else {
        current.access_for(class)
    };
    let access = narrower_capability_access(snapshot_access, current_access);
    if access != CapabilityAccess::Ask {
        return access;
    }
    let snapshotted_grant = bound.policy.grants.iter().any(|grant| {
        grant.class == class && grant.scope_kind == scope_kind && grant.scope_value == scope_value
    });
    let grant_still_active = current.grants.iter().any(|grant| {
        grant.class == class && grant.scope_kind == scope_kind && grant.scope_value == scope_value
    });
    if snapshotted_grant && grant_still_active {
        CapabilityAccess::Allow
    } else {
        CapabilityAccess::Ask
    }
}
