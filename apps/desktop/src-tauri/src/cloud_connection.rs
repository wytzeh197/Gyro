//! Narrow native commands. No credential, origin or return-URL arguments.
use gyro_core::cloud_connection::{
    hosted::{HostedConnection, Outcome},
    Action, Connection,
};
use serde::Deserialize;
use serde_json::Value;
use std::sync::Arc;
use tauri::Manager;
use tauri_plugin_opener::OpenerExt;
pub enum Adapter {
    Mock(Arc<Connection>),
    Staging(Arc<HostedConnection>),
    V2(Arc<gyro_core::cloud_connection::v2::Connection>),
}

#[derive(Deserialize)]
#[serde(
    tag = "operation",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub(crate) enum ServiceRequest {
    LocalChats,
    PreviewChat {
        local_id: uuid::Uuid,
    },
    PreviewReport {
        local_id: uuid::Uuid,
        report_id: uuid::Uuid,
    },
    PreviewSettings {
        preferences: Value,
    },
    PreviewAttachment,
    DownloadAttachment {
        object_id: uuid::Uuid,
        revision_id: Option<uuid::Uuid>,
        filename: Option<String>,
    },
    ExportAccountFiles,
    UploadPreview {
        ticket: uuid::Uuid,
        reviewed: bool,
    },
    ProjectMemoryId {
        local_id: Option<uuid::Uuid>,
    },
    Service {
        command: gyro_core::cloud_connection::v2::services::Command,
    },
    SaveReadOnlyArchive {
        content: gyro_core::cloud_connection::v2::selection::Chat,
    },
}
#[tauri::command]
pub(crate) async fn cloud_connection_service(
    app: tauri::AppHandle,
    request: ServiceRequest,
) -> Result<Value, String> {
    let connection = match &app.state::<CloudConnection>().0 {
        Adapter::V2(c) => c.clone(),
        _ => return Err("Hosted v2 Cloud is not configured.".into()),
    };
    tauri::async_runtime::spawn_blocking(move||{
        let result=(||->Result<Value,gyro_core::cloud_connection::v2::Error>{
            use gyro_core::cloud_connection::v2::Error;
            match request {
                ServiceRequest::LocalChats=>{let store=super::open_store().map_err(|_|Error::Storage)?;let rows=store.list_sessions().map_err(|_|Error::Storage)?;Ok(serde_json::json!({"items":rows.into_iter().map(|s|serde_json::json!({"localId":s.id,"title":s.title})).collect::<Vec<_>>()}))},
                ServiceRequest::PreviewChat{local_id}=>connection.preview_chat(local_id),
                ServiceRequest::PreviewReport{local_id,report_id}=>connection.preview_report(local_id,report_id),
                ServiceRequest::PreviewSettings{preferences}=>connection.preview_settings(preferences),
                ServiceRequest::PreviewAttachment=>{use tauri_plugin_dialog::DialogExt;use std::io::Read;let Some(file)=app.dialog().file().set_title("Select one attachment to review for Cloud upload").blocking_pick_file() else{return Ok(serde_json::json!({"cancelled":true}));};let path=file.into_path().map_err(|_|Error::Input)?;let meta=std::fs::symlink_metadata(&path).map_err(|_|Error::Input)?;if !meta.is_file()||meta.file_type().is_symlink()||meta.len()>50*1024*1024{return Err(Error::Input);}let name=path.file_name().and_then(|s|s.to_str()).ok_or(Error::Input)?;let file=std::fs::File::open(&path).map_err(|_|Error::Input)?;let mut bytes=Vec::new();file.take(50*1024*1024+1).read_to_end(&mut bytes).map_err(|_|Error::Input)?;connection.preview_attachment(name,bytes)},
                ServiceRequest::ExportAccountFiles=>{use tauri_plugin_dialog::DialogExt;let Some(folder)=app.dialog().file().set_title("Choose where to save a complete Cloud export").blocking_pick_folder()else{return Ok(serde_json::json!({"cancelled":true}));};let path=folder.into_path().map_err(|_|Error::Input)?;let metadata=std::fs::symlink_metadata(&path).map_err(|_|Error::Input)?;if !metadata.is_dir()||metadata.file_type().is_symlink(){return Err(Error::Input);}connection.export_to(&path)},
                ServiceRequest::DownloadAttachment{object_id,revision_id,filename}=>{use tauri_plugin_dialog::DialogExt;use base64::Engine;use std::io::Write;let result=connection.service(gyro_core::cloud_connection::v2::services::Command::ReadObject{object_id,revision_id})?;let bytes=base64::engine::general_purpose::STANDARD.decode(result["bytesBase64"].as_str().ok_or(Error::Protocol)?).map_err(|_|Error::Protocol)?;let name=result["filename"].as_str().map(str::to_owned).or(filename).unwrap_or_else(||"gyro-cloud-attachment.bin".into());gyro_core::cloud_connection::v2::selection::validate_attachment(&name,&bytes)?;let Some(file)=app.dialog().file().set_title("Save a separate attachment copy").set_file_name(&name).blocking_save_file() else{return Ok(serde_json::json!({"cancelled":true}));};let path=file.into_path().map_err(|_|Error::Input)?;let mut options=std::fs::OpenOptions::new();options.create_new(true).write(true);
                    #[cfg(unix)]{use std::os::unix::fs::OpenOptionsExt;options.mode(0o600);}
                    let mut out=options.open(path).map_err(|_|Error::Storage)?;out.write_all(&bytes).map_err(|_|Error::Storage)?;out.sync_all().map_err(|_|Error::Storage)?;Ok(serde_json::json!({"saved":true,"name":name}))},
                ServiceRequest::UploadPreview{ticket,reviewed}=>connection.upload_preview(ticket,reviewed),
                ServiceRequest::ProjectMemoryId{local_id}=>{let view=connection.view();let account=view.snapshot.as_ref().map(|s|s.account.id).ok_or(Error::Authentication)?;let key=if let Some(id)=local_id{let store=super::open_store().map_err(|_|Error::Storage)?;let s=store.get_session(id).map_err(|_|Error::Storage)?.ok_or(Error::Input)?;format!("memory:{account}:{}",s.workspace_path.display())}else{format!("memory:{account}:selected-project")};Ok(serde_json::json!({"projectId":connection.local_state()?.object_for_local(&key)?}))},
                ServiceRequest::Service{command}=>connection.service(command),
                ServiceRequest::SaveReadOnlyArchive{content}=>{let id=connection.save_read_only_archive(&content)?;Ok(serde_json::json!({"archiveId":id,"readOnly":true,"content":content,"notice":"Restored a separate read-only local copy. No project, approvals, tools or provider session were restored. The original chat is unchanged."}))},
            }
        })();result.map_err(|e|e.to_string())
    }).await.map_err(|_|"Cloud operation stopped.".to_string())?
}
pub struct CloudConnection(pub Adapter);
impl Default for CloudConnection {
    fn default() -> Self {
        if let Some(connection) = gyro_core::cloud_connection::v2::Connection::from_build() {
            return Self(Adapter::V2(Arc::new(connection)));
        }
        if gyro_core::cloud_connection::v2::Config::build_requested() {
            return Self(Adapter::Mock(Arc::new(Connection::default())));
        }
        #[cfg(debug_assertions)]
        if std::env::var("GYRO_CLOUD_MOCK_PORT").is_err() {
            if let Ok(port) = std::env::var("GYRO_CLOUD_STAGING_PORT") {
                if let Some(connection) = port
                    .parse::<u16>()
                    .ok()
                    .and_then(|p| HostedConnection::debug_port(p).ok())
                {
                    return Self(Adapter::Staging(Arc::new(connection)));
                }
            }
        }
        Self(Adapter::Mock(
            Arc::new(Connection::from_debug_environment()),
        ))
    }
}
#[tauri::command]
pub(crate) fn cloud_connection_view(app: tauri::AppHandle) -> Value {
    match &app.state::<CloudConnection>().0 {
        Adapter::Mock(c) => serde_json::to_value(c.view()).unwrap_or(Value::Null),
        Adapter::Staging(c) => serde_json::to_value(c.view()).unwrap_or(Value::Null),
        Adapter::V2(c) => serde_json::to_value(c.view()).unwrap_or(Value::Null),
    }
}
fn finish_v2(
    app: &tauri::AppHandle,
    outcome: gyro_core::cloud_connection::v2::Outcome,
) -> Result<Value, String> {
    if let Some(url) = outcome.open_url {
        app.opener().open_url(url, None::<&str>).map_err(|_| {
            "Could not open billing. Refresh your Cloud status before trying again.".to_string()
        })?;
    }
    serde_json::to_value(outcome.view).map_err(|_| "Could not read Cloud status.".into())
}
fn finish(app: &tauri::AppHandle, outcome: Outcome) -> Result<Value, String> {
    if let Some(url) = outcome.open_url {
        app.opener().open_url(url, None::<&str>).map_err(|_| {
            "Could not open staging billing. Refresh status before trying again.".to_string()
        })?;
    }
    serde_json::to_value(outcome.view).map_err(|_| "Could not read staging Cloud status.".into())
}
#[tauri::command]
pub(crate) async fn cloud_connection_action(
    app: tauri::AppHandle,
    action: Action,
) -> Result<Value, String> {
    let state = app.state::<CloudConnection>();
    match &state.0 {
        Adapter::V2(c) => {
            let c = c.clone();
            let result = tauri::async_runtime::spawn_blocking(move || {
                use gyro_core::cloud_connection::v2::Plan;
                match action {
                    Action::Read => Ok(gyro_core::cloud_connection::v2::Outcome {
                        view: c.view(),
                        open_url: None,
                    }),
                    Action::SubscribePlus => c.choose(Some(Plan::Plus)),
                    Action::SubscribePremium => c.choose(Some(Plan::Premium)),
                    Action::Restore => c.restore(),
                    Action::Refresh => c.refresh(),
                    Action::SignOut => c.sign_out(),
                    Action::ManageBilling => c.billing(None),
                    _ => Err(gyro_core::cloud_connection::v2::Error::Input),
                }
                .map_err(|e| e.to_string())
            })
            .await
            .map_err(|_| "Cloud action stopped.".to_string())??;
            finish_v2(&app, result)
        }
        Adapter::Mock(c) => {
            let c = c.clone();
            tauri::async_runtime::spawn_blocking(move || {
                c.run(action)
                    .map(|v| serde_json::to_value(v).unwrap_or(Value::Null))
                    .map_err(|e| e.to_string())
            })
            .await
            .map_err(|_| "Cloud action stopped.".to_string())?
        }
        Adapter::Staging(c) => {
            let c = c.clone();
            let result = tauri::async_runtime::spawn_blocking(move || {
                c.run(action).map_err(|e| e.to_string())
            })
            .await
            .map_err(|_| "Staging Cloud action stopped.".to_string())??;
            finish(&app, result)
        }
    }
}
#[tauri::command]
pub(crate) async fn cloud_connection_begin(
    app: tauri::AppHandle,
    email: String,
    remember: Option<bool>,
) -> Result<Value, String> {
    if let Adapter::V2(c) = &app.state::<CloudConnection>().0 {
        let c = c.clone();
        let result = tauri::async_runtime::spawn_blocking(move || {
            c.begin(&email, remember.unwrap_or(false))
                .map_err(|e| e.to_string())
        })
        .await
        .map_err(|_| "Cloud sign-in stopped.".to_string())??;
        return finish_v2(&app, result);
    }
    let c = match &app.state::<CloudConnection>().0 {
        Adapter::Staging(c) => c.clone(),
        _ => return Err("Staging sign-in is not configured.".into()),
    };
    let result =
        tauri::async_runtime::spawn_blocking(move || c.begin(&email).map_err(|e| e.to_string()))
            .await
            .map_err(|_| "Staging sign-in stopped.".to_string())??;
    finish(&app, result)
}
#[tauri::command]
pub(crate) async fn cloud_connection_verify(
    app: tauri::AppHandle,
    proof: String,
) -> Result<Value, String> {
    if let Adapter::V2(c) = &app.state::<CloudConnection>().0 {
        let c = c.clone();
        let result = tauri::async_runtime::spawn_blocking(move || {
            c.verify(&proof).map_err(|e| e.to_string())
        })
        .await
        .map_err(|_| "Cloud verification stopped.".to_string())??;
        return finish_v2(&app, result);
    }
    let c = match &app.state::<CloudConnection>().0 {
        Adapter::Staging(c) => c.clone(),
        _ => return Err("Staging sign-in is not configured.".into()),
    };
    let result =
        tauri::async_runtime::spawn_blocking(move || c.verify(&proof).map_err(|e| e.to_string()))
            .await
            .map_err(|_| "Staging verification stopped.".to_string())??;
    finish(&app, result)
}
