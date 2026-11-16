//! Native review tickets bind selected content to the current account and sign-in.
use gyro_core::cloud_connection::v3::{
    connection::{Command, Connection},
    continuity::Handoff,
    Error,
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};
use tauri::Manager;
use tauri_plugin_dialog::DialogExt;
use uuid::Uuid;
#[derive(Clone, Copy, PartialEq)]
enum Kind {
    Chat,
    Report,
    Phone,
}
struct Preview {
    epoch: u64,
    owner: Uuid,
    kind: Kind,
    bytes: Vec<u8>,
}
pub struct CloudV3(pub Option<Arc<Connection>>, Mutex<HashMap<Uuid, Preview>>);
impl Default for CloudV3 {
    fn default() -> Self {
        Self(
            Connection::from_build().map(Arc::new),
            Mutex::new(HashMap::new()),
        )
    }
}
#[derive(Deserialize)]
#[serde(
    tag = "operation",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub(crate) enum Request {
    View,
    Profile,
    UpdateProfile {
        display_name: String,
    },
    Begin {
        email: String,
        subscribe: bool,
        remember: bool,
    },
    Verify {
        code: String,
        #[serde(default)]
        remember: bool,
    },
    Reconnect,
    RegisterDevice {
        new_identity: bool,
    },
    SignOut,
    PreviewProject,
    Prepare {
        ticket: Uuid,
        object_id: Uuid,
        base_revision_id: Option<Uuid>,
        label: String,
        reviewed: bool,
    },
    Resume {
        request_id: Uuid,
    },
    Cancel {
        request_id: Uuid,
    },
    Renew {
        request_id: Uuid,
    },
    Pending,
    RestoreProject {
        revision_id: Uuid,
    },
    Service {
        command: Command,
    },
    LocalHandoff {
        handoff: Handoff,
    },
    LocalChats,
    PreviewChat {
        local_id: Uuid,
        project_revision: Option<Uuid>,
    },
    SaveChat {
        ticket: Uuid,
        object_id: Uuid,
        reviewed: bool,
    },
    ReadChat {
        revision_id: Uuid,
    },
    LocalReports {
        local_id: Uuid,
    },
    PreviewReport {
        local_id: Uuid,
        report_id: Uuid,
    },
    SaveReport {
        ticket: Uuid,
        object_id: Uuid,
        reviewed: bool,
    },
    ReadReport {
        revision_id: Uuid,
    },
    PreviewPhone {
        local_id: Uuid,
    },
    PublishPhone {
        ticket: Uuid,
        reviewed: bool,
    },
    DiscardPreview {
        ticket: Uuid,
    },
    ExportFiles {
        export_id: Uuid,
    },
}
fn preview(
    app: &tauri::AppHandle,
    c: &Connection,
    identity: (u64, Uuid),
    kind: Kind,
    content: Value,
) -> Result<Value, Error> {
    let bytes = serde_json::to_vec(&content)?;
    if bytes.len() > 4 * 1024 * 1024 {
        return Err(Error::Limit);
    }
    let state = app.state::<CloudV3>();
    let mut list = state.1.lock().unwrap_or_else(|e| e.into_inner());
    if c.consent_identity()? != identity {
        return Err(Error::Identity);
    }
    list.retain(|_, p| p.kind != kind && (p.epoch, p.owner) == identity);
    if list.len() >= 2 {
        return Err(Error::Limit);
    }
    let ticket = Uuid::new_v4();
    list.insert(
        ticket,
        Preview {
            epoch: identity.0,
            owner: identity.1,
            kind,
            bytes,
        },
    );
    Ok(json!({"ticket":ticket,"content":content,"requiresSeparateConsent":true}))
}
fn claim(
    app: &tauri::AppHandle,
    c: &Connection,
    ticket: Uuid,
    kind: Kind,
    reviewed: bool,
) -> Result<Vec<u8>, Error> {
    if !reviewed {
        return Err(Error::Changed);
    }
    let p = app
        .state::<CloudV3>()
        .1
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(&ticket)
        .ok_or(Error::Changed)?;
    if c.consent_identity()? != (p.epoch, p.owner) || p.kind != kind {
        return Err(Error::Identity);
    }
    Ok(p.bytes)
}
fn chats() -> Result<Value, Error> {
    let store = crate::stores::open_store().map_err(|_| Error::Unavailable)?;
    Ok(
        json!({"items":store.list_sessions().map_err(|_|Error::Unavailable)?.into_iter().map(|s|json!({"id":s.id,"title":s.title})).collect::<Vec<_>>()}),
    )
}
#[tauri::command]
pub(crate) async fn cloud_v3(app: tauri::AppHandle, request: Request) -> Result<Value, String> {
    if let Request::LocalHandoff { handoff } = request {
        return handoff
            .reviewed_text()
            .map(|text| json!({"text":text,"requiresReview":true,"transfersAuthority":false}))
            .map_err(|e| e.to_string());
    }
    let c = app.state::<CloudV3>().0.clone();
    if matches!(request, Request::View) && c.is_none() {
        return Ok(
            json!({"configured":false,"connected":false,"contractVersion":"3.0.0","policyVersion":gyro_core::cloud_connection::v3::POLICY,"accountId":null}),
        );
    }
    let c = c.ok_or_else(|| {
        "Gyro Cloud v3 has not passed release acceptance. Local work remains available.".to_string()
    })?;
    // The existing local Check flow remains free and keeps its own approvals.
    if let Request::LocalReports { local_id } = request {
        return super::local_check::list_local_checks(local_id.to_string()).await.map(|reports|json!({"items":reports.into_iter().map(|r|json!({"id":r.plan.id,"finishedAt":r.finished_at,"stale":r.stale})).collect::<Vec<_>>()}));
    }
    tauri::async_runtime::spawn_blocking(move || {
        run_request(app, c, request).map_err(|e| e.to_string())
    })
    .await
    .map_err(|_| "Cloud action stopped. Local work remains available.".to_string())?
}
fn run_request(
    app: tauri::AppHandle,
    c: Arc<Connection>,
    request: Request,
) -> Result<Value, Error> {
    match request {
        Request::View => Ok(serde_json::to_value(c.refreshed_view())?),
        Request::Profile => c.profile(),
        Request::UpdateProfile { display_name } => c.update_profile(&display_name),
        Request::Begin {
            email,
            subscribe,
            remember,
        } => {
            c.begin(&email, subscribe, remember)?;
            Ok(json!({"codeRequested":true}))
        }
        Request::Verify { code, remember } => c.verify(&code, remember),
        Request::RegisterDevice { new_identity } => c.register_device(new_identity),
        Request::Reconnect => {
            c.restore_session()?;
            Ok(serde_json::to_value(c.view())?)
        }
        Request::SignOut => {
            app.state::<CloudV3>()
                .1
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .clear();
            c.sign_out()?;
            Ok(json!({"signedOut":true,"localFilesPreserved":true}))
        }
        Request::PreviewProject => {
            let Some(folder) = app
                .dialog()
                .file()
                .set_title("Select a project to review for Cloud save")
                .blocking_pick_folder()
            else {
                return Ok(json!({"cancelled":true}));
            };
            c.preview_project(&folder.into_path().map_err(|_| Error::Path)?)
        }
        Request::Prepare {
            ticket,
            object_id,
            base_revision_id,
            label,
            reviewed,
        } => c.prepare(ticket, object_id, base_revision_id, label, reviewed),
        Request::Resume { request_id } => c.resume(request_id),
        Request::Cancel { request_id } => {
            c.cancel(request_id)?;
            Ok(json!({"cancelled":true}))
        }
        Request::Renew { request_id } => {
            c.renew(request_id)?;
            Ok(json!({"renewed":true}))
        }
        Request::Pending => c.pending(),
        Request::RestoreProject { revision_id } => {
            let Some(folder) = app
                .dialog()
                .file()
                .set_title("Choose a NEW folder for the restored project")
                .set_file_name("Restored project")
                .blocking_save_file()
            else {
                return Ok(json!({"cancelled":true}));
            };
            c.restore_project(revision_id, &folder.into_path().map_err(|_| Error::Path)?)?;
            Ok(json!({"restored":true,"authorityTransferred":false}))
        }
        Request::Service { command } => c.service(command),
        Request::LocalHandoff { handoff } => Ok(json!({"text":handoff.reviewed_text()?})),
        Request::LocalChats => chats(),
        Request::PreviewChat {
            local_id,
            project_revision,
        } => {
            let identity = c.consent_identity()?;
            let store = crate::stores::open_store().map_err(|_| Error::Unavailable)?;
            let archive = gyro_core::cloud_connection::v2::selection::Chat::from_bounded_session(
                &store,
                local_id,
                identity.1,
                4 * 1024 * 1024 - 4096,
            )
            .map_err(|_| Error::Integrity)?;
            preview(
                &app,
                &c,
                identity,
                Kind::Chat,
                json!({"format":"gyro-continuity-chat-v1","projectRevision":project_revision,"archive":archive,"unsupported":["Provider-native session data, tool payloads, attachments and runtime permissions are excluded. The original local archive is unchanged."]}),
            )
        }
        Request::SaveChat {
            ticket,
            object_id,
            reviewed,
        } => {
            let bytes = claim(&app, &c, ticket, Kind::Chat, reviewed)?;
            c.save_content("chat", "Selected chat", &bytes, object_id, None, true)
        }
        Request::ReadChat { revision_id } => c.read_chat(revision_id),
        Request::LocalReports { .. } => Err(Error::Changed),
        Request::PreviewReport {
            local_id,
            report_id,
        } => {
            let identity = c.consent_identity()?;
            let text = super::local_check::cloud_report_preview(local_id, report_id)
                .map_err(|_| Error::Integrity)?;
            preview(
                &app,
                &c,
                identity,
                Kind::Report,
                json!({"text":text,"readOnly":true,"authorityTransferred":false}),
            )
        }
        Request::SaveReport {
            ticket,
            object_id,
            reviewed,
        } => {
            let value: Value =
                serde_json::from_slice(&claim(&app, &c, ticket, Kind::Report, reviewed)?)?;
            let text = value["text"].as_str().ok_or(Error::Integrity)?;
            c.save_content(
                "report",
                "Gyro Check report",
                text.as_bytes(),
                object_id,
                None,
                true,
            )
        }
        Request::ReadReport { revision_id } => c.read_report(revision_id),
        Request::PreviewPhone { local_id } => {
            let identity = c.consent_identity()?;
            let store = crate::stores::open_store().map_err(|_| Error::Unavailable)?;
            let archive = gyro_core::cloud_connection::v2::selection::Chat::from_bounded_session(
                &store,
                local_id,
                identity.1,
                4 * 1024 * 1024 - 4096,
            )
            .map_err(|_| Error::Integrity)?;
            let messages = archive
                .messages
                .iter()
                .rev()
                .take(3)
                .collect::<Vec<_>>()
                .into_iter()
                .rev()
                .map(
                    |m| json!({"role":m.role,"text":m.text.chars().take(2000).collect::<String>()}),
                )
                .collect::<Vec<_>>();
            preview(
                &app,
                &c,
                identity,
                Kind::Phone,
                json!({"sessionId":local_id,"projectLabel":archive.title.chars().take(120).collect::<String>(),"status":"not-checked","summary":"Manual selected message snapshot. Current execution state has not been checked. Messages longer than 2,000 characters are shortened in this preview.","messages":messages,"checks":[],"consent":true}),
            )
        }
        Request::PublishPhone { ticket, reviewed } => {
            let content = serde_json::from_slice(&claim(&app, &c, ticket, Kind::Phone, reviewed)?)?;
            c.publish_phone(content)
        }
        Request::DiscardPreview { ticket } => {
            c.discard_preview(ticket)?;
            app.state::<CloudV3>()
                .1
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .remove(&ticket);
            Ok(json!({"discarded":true}))
        }
        Request::ExportFiles { export_id } => {
            let Some(folder) = app
                .dialog()
                .file()
                .set_title("Choose a folder for a separate resumable Cloud export")
                .blocking_pick_folder()
            else {
                return Ok(json!({"cancelled":true}));
            };
            Ok(
                json!({"exported":c.export_to(export_id,&folder.into_path().map_err(|_|Error::Path)?)?}),
            )
        }
    }
}

#[cfg(test)]
mod request_tests {
    use super::*;
    #[test]
    fn settings_requests_cannot_supply_upload_paths_credentials_or_account_authority() {
        let id = Uuid::new_v4();
        let valid: Request =
            serde_json::from_value(json!({"operation":"update-profile","displayName":"Fixture"}))
                .unwrap();
        assert!(
            matches!(valid, Request::UpdateProfile { display_name } if display_name == "Fixture")
        );
        let valid: Request = serde_json::from_value(
            json!({"operation":"service","command":{"operation":"revoke-device","deviceId":id}}),
        )
        .unwrap();
        assert!(
            matches!(valid, Request::Service { command: Command::RevokeDevice { device_id } } if device_id == id)
        );
        for value in [
            json!({"operation":"update-profile","displayName":"Fixture","accountId":id}),
            json!({"operation":"service","command":{"operation":"revoke-device","deviceId":id,"accessToken":"renderer-supplied"}}),
            json!({"operation":"prepare","ticket":id,"objectId":id,"baseRevisionId":null,"label":"Fixture","reviewed":true,"credentials":"renderer-supplied"}),
        ] {
            assert!(serde_json::from_value::<Request>(value).is_err());
        }
    }

    #[test]
    fn final_verification_remember_choice_is_explicit_and_defaults_to_ephemeral() {
        for remember in [true, false] {
            let value = serde_json::from_value::<Request>(
                json!({"operation":"verify","code":"111111","remember":remember}),
            )
            .unwrap();
            assert!(matches!(value,Request::Verify{remember:value,..} if value==remember));
        }
        let legacy =
            serde_json::from_value::<Request>(json!({"operation":"verify","code":"111111"}))
                .unwrap();
        assert!(matches!(
            legacy,
            Request::Verify {
                remember: false,
                ..
            }
        ));
        assert!(serde_json::from_value::<Request>(
            json!({"operation":"verify","code":"111111","remember":"true"})
        )
        .is_err());
    }
}
