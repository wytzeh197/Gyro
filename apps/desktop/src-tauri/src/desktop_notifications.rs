//! Native notifications Gyro sends while it is in the background: approval
//! requests, finished work, and failures.
//!
//! Every notice goes through [`deliver`], which checks the user's
//! notification preferences (mirrored from Settings through the menu bar
//! snapshot), that no Gyro window is focused, and that macOS granted
//! permission. Bodies stay generic: a notice can land on a lock screen, so it
//! never carries a prompt, command, path or model output.

use crate::menu_bar::{DesktopNotificationPreferences, MenuBarController, MenuBarOutcome};
use crate::{
    automation_notification_content, restore_main_window, Automation, ProviderApprovalContext,
    ProviderApprovalNotificationOpen, PROVIDER_APPROVAL_NOTIFICATION_OPEN_EVENT,
};
use tauri::{Emitter, Manager};
use tauri_plugin_notification::{NotificationExt, PermissionState};
use uuid::Uuid;

/// The kind of notice, each switched on or off separately in Settings.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum NoticeKind {
    Approval,
    Finished,
    Failed,
}

/// Chat titles are generated from the first prompt, so only a short one is
/// shown; anything longer is cut at a word boundary.
const CHAT_TITLE_LIMIT: usize = 60;

pub(crate) fn kind_allowed(preferences: &DesktopNotificationPreferences, kind: NoticeKind) -> bool {
    preferences.enabled
        && match kind {
            NoticeKind::Approval => preferences.approvals,
            NoticeKind::Finished => preferences.finished,
            NoticeKind::Failed => preferences.failed,
        }
}

pub(crate) fn should_show_background_notification(
    window_visible: bool,
    window_focused: bool,
) -> bool {
    !window_visible || !window_focused
}

fn app_is_in_background(app: &tauri::AppHandle) -> bool {
    app.webview_windows().values().all(|window| {
        should_show_background_notification(
            window.is_visible().unwrap_or(false),
            window.is_focused().unwrap_or(false),
        )
    })
}

pub(crate) fn notification_permission_allows_delivery(permission: PermissionState) -> bool {
    permission == PermissionState::Granted
}

fn can_deliver(app: &tauri::AppHandle, kind: NoticeKind) -> bool {
    let preferences = app.state::<MenuBarController>().notification_preferences();
    if !kind_allowed(&preferences, kind) || !app_is_in_background(app) {
        return false;
    }
    app.notification()
        .permission_state()
        .is_ok_and(notification_permission_allows_delivery)
}

/// Shows one notice. On macOS a click runs `on_click` (opening what the
/// notice is about); elsewhere the plugin's plain notice is used.
fn deliver(
    app: &tauri::AppHandle,
    kind: NoticeKind,
    title: &str,
    body: String,
    on_click: impl FnOnce(&tauri::AppHandle) + Send + 'static,
) {
    if !can_deliver(app, kind) {
        return;
    }

    #[cfg(target_os = "macos")]
    {
        let app = app.clone();
        let title = title.to_string();
        std::thread::spawn(move || {
            let application = if tauri::is_dev() {
                "com.apple.Terminal".to_string()
            } else {
                app.config().identifier.clone()
            };
            if let Err(error) = notify_rust::set_application(&application) {
                eprintln!("could not configure Gyro notification: {error}");
            }
            let mut notification = notify_rust::Notification::new();
            notification.summary(&title).body(&body);
            match notification.show() {
                Ok(handle) => handle.wait_for_action(move |action| {
                    if action == "__closed" {
                        return;
                    }
                    if let Err(error) = restore_main_window(&app) {
                        eprintln!("could not focus Gyro from notification: {error}");
                    }
                    on_click(&app);
                }),
                Err(error) => eprintln!("could not show Gyro notification: {error}"),
            }
        });
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = on_click;
        if let Err(error) = app.notification().builder().title(title).body(body).show() {
            eprintln!("could not show Gyro notification: {error}");
        }
    }
}

pub(crate) fn provider_approval_notification_body(
    approval_type: &str,
    provider_label: Option<&str>,
) -> String {
    let provider = provider_label
        .map(str::trim)
        .filter(|label| !label.is_empty())
        .unwrap_or("Your model");
    let action = match approval_type {
        "command" => "run a command",
        "file-change" => "change files",
        _ => "use a protected capability",
    };
    format!("{provider} wants to {action}. Open this chat to review it.")
}

pub(crate) fn notify_provider_approval_question(
    app: &tauri::AppHandle,
    context: &ProviderApprovalContext,
    approval_id: Uuid,
    approval_type: &str,
) {
    let body =
        provider_approval_notification_body(approval_type, context.provider_label.as_deref());
    let payload = ProviderApprovalNotificationOpen {
        session_id: context.session_id.clone(),
        approval_id: approval_id.to_string(),
    };
    deliver(
        app,
        NoticeKind::Approval,
        "Gyro has a question",
        body,
        move |app| {
            if let Err(error) = app.emit(PROVIDER_APPROVAL_NOTIFICATION_OPEN_EVENT, payload) {
                eprintln!("could not open approval chat from notification: {error}");
            }
        },
    );
}

pub(crate) fn notify_automation_outcome(app: &tauri::AppHandle, automation: &Automation) {
    let Some((title, body)) = automation_notification_content(automation) else {
        return;
    };
    let kind = if title.ends_with("finished") {
        NoticeKind::Finished
    } else {
        NoticeKind::Failed
    };
    let target = automation.id.to_string();
    deliver(app, kind, title, body.to_string(), move |app| {
        open_menu_bar_target(app, "automation", target);
    });
}

fn short_chat_title(title: &str) -> String {
    let title = title.split_whitespace().collect::<Vec<_>>().join(" ");
    if title.chars().count() <= CHAT_TITLE_LIMIT {
        return title;
    }
    let cut: String = title.chars().take(CHAT_TITLE_LIMIT).collect();
    let cut = cut.rsplit_once(' ').map_or(cut.as_str(), |(head, _)| head);
    format!("{cut}…")
}

/// The notice for a chat turn that just ended, or `None` for a stop the user
/// asked for. Automations are left to [`notify_automation_outcome`], which
/// the scheduler calls with the run itself.
pub(crate) fn chat_outcome_notification(
    outcome: &MenuBarOutcome,
) -> Option<(NoticeKind, &'static str, String)> {
    if outcome.kind != "chat" {
        return None;
    }
    let title = short_chat_title(&outcome.title);
    let title = if title.is_empty() {
        "A chat".to_string()
    } else {
        format!("“{title}”")
    };
    match outcome.status.as_str() {
        "succeeded" => Some((
            NoticeKind::Finished,
            "Gyro finished",
            format!("{title} is done. Open Gyro to read the reply."),
        )),
        "failed" => Some((
            NoticeKind::Failed,
            "Gyro hit a problem",
            format!("{title} stopped with an error. Open Gyro to see what happened."),
        )),
        _ => None,
    }
}

pub(crate) fn notify_chat_outcome(app: &tauri::AppHandle, outcome: &MenuBarOutcome) {
    let Some((kind, title, body)) = chat_outcome_notification(outcome) else {
        return;
    };
    let target = outcome.target_id.clone();
    deliver(app, kind, title, body, move |app| {
        open_menu_bar_target(app, "chat", target);
    });
}

fn open_menu_bar_target(app: &tauri::AppHandle, kind: &str, id: String) {
    let target = crate::menu_bar::MenuBarTarget {
        kind: kind.into(),
        id,
    };
    if let Err(error) = app.emit_to("main", crate::menu_bar::MENU_BAR_NAVIGATION_EVENT, target) {
        eprintln!("could not open Gyro from notification: {error}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn outcome(status: &str, title: &str) -> MenuBarOutcome {
        MenuBarOutcome {
            id: "chat:1:turn".into(),
            kind: "chat".into(),
            target_id: "session-1".into(),
            title: title.into(),
            detail: "/private/workspace/secret.txt".into(),
            status: status.into(),
            finished_at: "2026-09-28T10:00:00Z".into(),
        }
    }

    #[test]
    fn background_notifications_defer_to_the_focused_app() {
        assert!(!should_show_background_notification(true, true));
        assert!(should_show_background_notification(true, false));
        assert!(should_show_background_notification(false, false));
        assert!(should_show_background_notification(false, true));
    }

    #[test]
    fn automation_notifications_require_explicit_native_permission() {
        assert!(notification_permission_allows_delivery(
            PermissionState::Granted
        ));
        assert!(!notification_permission_allows_delivery(
            PermissionState::Denied
        ));
        assert!(!notification_permission_allows_delivery(
            PermissionState::Prompt
        ));
        assert!(!notification_permission_allows_delivery(
            PermissionState::PromptWithRationale
        ));
    }

    #[test]
    fn provider_approval_notifications_are_actionable_and_private() {
        let command = provider_approval_notification_body("command", Some("Claude"));
        assert_eq!(
            command,
            "Claude wants to run a command. Open this chat to review it."
        );
        assert_eq!(
            provider_approval_notification_body("file-change", Some("OpenAI")),
            "OpenAI wants to change files. Open this chat to review it."
        );
        assert!(!command.contains("/private/workspace"));
    }

    #[test]
    fn each_notice_kind_follows_its_own_switch_and_the_master_switch() {
        let mut preferences = DesktopNotificationPreferences::default();
        assert!(kind_allowed(&preferences, NoticeKind::Approval));
        assert!(kind_allowed(&preferences, NoticeKind::Finished));
        preferences.finished = false;
        assert!(!kind_allowed(&preferences, NoticeKind::Finished));
        assert!(kind_allowed(&preferences, NoticeKind::Failed));
        preferences.enabled = false;
        assert!(!kind_allowed(&preferences, NoticeKind::Approval));
        assert!(!kind_allowed(&preferences, NoticeKind::Failed));
    }

    #[test]
    fn chat_outcomes_name_the_chat_but_never_its_output() {
        let (kind, title, body) =
            chat_outcome_notification(&outcome("succeeded", "Fix  tray\nicon tint")).unwrap();
        assert_eq!(kind, NoticeKind::Finished);
        assert_eq!(title, "Gyro finished");
        assert_eq!(
            body,
            "“Fix tray icon tint” is done. Open Gyro to read the reply."
        );
        assert!(!body.contains("/private/workspace"));

        let (kind, _, body) = chat_outcome_notification(&outcome("failed", "")).unwrap();
        assert_eq!(kind, NoticeKind::Failed);
        assert!(body.starts_with("A chat stopped with an error"));

        assert!(chat_outcome_notification(&outcome("stopped", "Chat")).is_none());
        let mut automation = outcome("succeeded", "Nightly audit");
        automation.kind = "automation".into();
        assert!(chat_outcome_notification(&automation).is_none());
    }

    #[test]
    fn long_chat_titles_are_cut_at_a_word() {
        let long = "Refactor the provider approval broker so capability approvals share one queue";
        let short = short_chat_title(long);
        assert!(short.ends_with('…'));
        assert!(short.chars().count() <= CHAT_TITLE_LIMIT + 1);
        assert!(!short.contains("queue"));
    }
}
