//! Bounded inspection identity, kept apart from the outcome/error sentence.
use gyro_core::{CapabilityId, CapabilityRequest};
use uuid::Uuid;
thread_local! {
    static ACTIVE: std::cell::RefCell<Vec<(Uuid, serde_json::Value)>> = const { std::cell::RefCell::new(Vec::new()) };
}
pub(super) struct Scope(Uuid);
fn identity(id: CapabilityId, arguments: &serde_json::Value) -> serde_json::Value {
    let mut fields = serde_json::Map::new();
    if matches!(
        id,
        CapabilityId::WorkspaceSearch
            | CapabilityId::WorkspaceRead
            | CapabilityId::WorkspaceReadRange
            | CapabilityId::WorkspaceReadEditor
    ) {
        for key in ["query", "path", "rootId"] {
            if let Some(value) = arguments.get(key).and_then(serde_json::Value::as_str) {
                fields.insert(
                    key.into(),
                    serde_json::json!(gyro_core::sanitize_capability_summary(
                        &value.chars().take(256).collect::<String>()
                    )),
                );
            }
        }
    }
    fields.into()
}
impl Scope {
    pub(super) fn start(request: &CapabilityRequest) -> Self {
        ACTIVE.with(|active| {
            active.borrow_mut().push((
                request.context.call_id,
                identity(request.capability_id, &request.arguments),
            ))
        });
        Self(request.context.call_id)
    }
}
impl Drop for Scope {
    fn drop(&mut self) {
        ACTIVE.with(|active| active.borrow_mut().retain(|(id, _)| *id != self.0));
    }
}
pub(super) fn annotate(call_id: Uuid, payload: &mut serde_json::Value) {
    ACTIVE.with(|active| {
        if let Some((_, identity)) = active.borrow().iter().rev().find(|(id, _)| *id == call_id) {
            if identity
                .as_object()
                .is_some_and(|fields| !fields.is_empty())
            {
                payload["inspection"] = identity.clone();
                if payload["status"] == "failed" {
                    let message = payload["summary"].as_str().unwrap_or_default();
                    payload["inspection"]["errorCode"] =
                        serde_json::json!(if message.contains("No such file or directory") {
                            "path-not-found"
                        } else if message.contains("Workspace search path") {
                            "invalid-search-scope"
                        } else {
                            "execution-failed"
                        });
                }
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn inspection_identity_is_bounded_and_never_keeps_contents() {
        let value = identity(
            CapabilityId::WorkspaceSearch,
            &serde_json::json!({
                "query":"needle|other", "path":"src/file.ts", "rootId":"root", "content":"private contents",
            }),
        );
        assert_eq!(value["query"], "needle|other");
        assert_eq!(value["path"], "src/file.ts");
        assert!(value.get("content").is_none());
        let bounded = identity(
            CapabilityId::WorkspaceSearch,
            &serde_json::json!({"query":"é".repeat(1000)}),
        );
        assert!(bounded["query"].as_str().unwrap().chars().count() <= 256);
        assert_eq!(
            identity(
                CapabilityId::WorkspaceEdit,
                &serde_json::json!({"path":"src/private.ts"})
            ),
            serde_json::json!({})
        );
    }
}
