//! Bridge Codex's native image-generation items into durable chat image replies.
//! Keep image bytes out of activities/transcripts and use the existing private,
//! session-scoped attachment storage and preview resolver.

use crate::{
    app::limits::{
        MAX_CHAT_ATTACHMENTS, MAX_CHAT_IMAGE_BYTES, MAX_CHAT_RESPONSE_CHARS, TEXT_TRUNCATION_SUFFIX,
    },
    providers::{chat_types::ChatMode, types::ProviderActivity},
    sessions::{
        attachments::{
            ensure_attachment_storage_quota, ensure_private_attachment_directory,
            validated_chat_media_type, write_private_attachment,
        },
        commands::attachment_session_lock,
    },
    stores::parse_uuid,
    text::truncate_chars,
    workspace::files::read_bounded_regular_file,
};
use base64::Engine as _;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    path::{Path, PathBuf},
};

pub(super) fn config_arg(mode: &ChatMode) -> &'static str {
    if *mode == ChatMode::Normal {
        "features.image_generation=true"
    } else {
        "features.image_generation=false"
    }
}

#[derive(Default)]
pub(super) struct GeneratedImages {
    completed: HashSet<String>,
    images: Vec<(PathBuf, Option<String>)>,
    failures: Vec<String>,
}

impl GeneratedImages {
    /// Only accept image events for the active thread/turn. A resumed thread's
    /// historical images must not be imported into the new reply.
    pub(super) fn accepts(params: &Value, thread: &str, turn: Option<&str>) -> bool {
        params.get("threadId").and_then(Value::as_str) == Some(thread)
            && turn.is_some_and(|turn| params.get("turnId").and_then(Value::as_str) == Some(turn))
    }

    pub(super) fn started(item: &Value) -> ProviderActivity {
        activity(item, "Generating image", "running", None)
    }

    pub(super) fn complete(
        &mut self,
        item: &Value,
        sessions_dir: &Path,
        session_id: &str,
    ) -> Option<ProviderActivity> {
        let id = item.get("id").and_then(Value::as_str)?;
        if self.completed.contains(id) {
            return None;
        }
        if self.completed.len() >= MAX_CHAT_ATTACHMENTS {
            let notice =
                "Additional generated images exceeded this reply's image limit.".to_owned();
            if !self.failures.contains(&notice) {
                self.failures.push(notice.clone());
            }
            return Some(activity(
                item,
                "Image preview limit reached",
                "failed",
                Some(notice),
            ));
        }
        self.completed.insert(id.to_owned());
        let result = if item.get("status").and_then(Value::as_str) != Some("completed")
            || item
                .get("failure")
                .is_some_and(|failure| !failure.is_null())
        {
            Err(
                if item.pointer("/failure/type").and_then(Value::as_str)
                    == Some("usageLimitExceeded")
                {
                    "Image generation reached the provider's usage limit.".to_owned()
                } else {
                    "The provider did not complete image generation.".to_owned()
                },
            )
        } else {
            image_bytes(item).and_then(|bytes| store_image(sessions_dir, session_id, &bytes))
        };
        Some(match result {
            Ok(path) => {
                if !self.images.iter().any(|(saved, _)| saved == &path) {
                    self.images.push((
                        path,
                        item.get("savedPath")
                            .and_then(Value::as_str)
                            .filter(|path| !path.is_empty())
                            .map(str::to_owned),
                    ));
                }
                activity(item, "Generated image", "done", None)
            }
            Err(error) => {
                let notice = format!("Image generation: {error}");
                if !self.failures.contains(&notice) {
                    self.failures.push(notice.clone());
                }
                activity(item, "Image generation failed", "failed", Some(notice))
            }
        })
    }

    pub(super) fn reply(&self, text: &str) -> String {
        let mut text = text.to_owned();
        let mut appendix = Vec::new();
        for (path, source) in &self.images {
            // File URLs escape spaces and Unicode; also escape parentheses
            // so arbitrary parent-directory names remain valid Markdown.
            // the existing resolver decodes them and checks the session root.
            let Ok(url) = url::Url::from_file_path(path) else {
                continue;
            };
            let target = url.as_str().replace('(', "%28").replace(')', "%29");
            if let Some(source) = source {
                let mut sources = vec![source.clone()];
                if let Ok(url) = url::Url::from_file_path(source) {
                    sources.push(url.to_string());
                }
                for source in sources {
                    // Replace complete citations only. Replacing a bare path
                    // inside a file URL would produce file://file:///... .
                    for citation in [format!("]({source})"), format!("](<{source}>)")] {
                        text = text.replace(&citation, &format!("]({target})"));
                    }
                    text = text.replace(&format!("`{source}`"), &format!("`{target}`"));
                }
            }
            // Preserve a model's own image caption when it already linked the
            // saved image. Otherwise supply the image even for a textless turn.
            if !text.contains(&format!("]({target})")) {
                appendix.push(format!("![Generated image]({target})"));
            }
        }
        appendix.extend(self.failures.iter().cloned());
        if appendix.is_empty() {
            return text;
        }
        let appendix = appendix.join("\n\n");
        let budget = MAX_CHAT_RESPONSE_CHARS.saturating_sub(appendix.chars().count() + 2);
        let text = text.trim();
        let text = if text.chars().count() > budget {
            truncate_chars(
                text,
                budget.saturating_sub(TEXT_TRUNCATION_SUFFIX.chars().count()),
            )
        } else {
            text.to_owned()
        };
        if text.is_empty() {
            appendix
        } else {
            format!("{text}\n\n{appendix}")
        }
    }
}

fn activity(item: &Value, label: &str, status: &str, note: Option<String>) -> ProviderActivity {
    ProviderActivity {
        id: item
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or("image-generation")
            .into(),
        kind: "tool".into(),
        label: label.into(),
        detail: Some("image_generation".into()),
        note,
        file_counts: None,
        status: status.into(),
    }
}

fn image_bytes(item: &Value) -> Result<Vec<u8>, String> {
    let result = item
        .get("result")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let max_encoded = (MAX_CHAT_IMAGE_BYTES as usize).div_ceil(3) * 4;
    if result.len() > max_encoded {
        return Err("the generated image exceeds the 10 MB preview limit.".into());
    }
    if !result.is_empty() {
        if let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(result) {
            return Ok(bytes);
        }
    }
    // Codex can omit notification media and supply its own savedPath instead.
    // This is an output from the local runner, never a renderer-requested path.
    // Copy it into Gyro storage, without expanding the preview resolver's roots.
    let path = item
        .get("savedPath")
        .and_then(Value::as_str)
        .map(Path::new)
        .filter(|path| path.is_absolute())
        .ok_or_else(|| "the provider returned no readable image data.".to_owned())?;
    read_bounded_regular_file(path, MAX_CHAT_IMAGE_BYTES as usize, "generated image")
        .map(|(bytes, _)| bytes)
        .map_err(|_| "the provider's generated image file could not be read.".into())
}

fn store_image(sessions_dir: &Path, session_id: &str, bytes: &[u8]) -> Result<PathBuf, String> {
    if bytes.is_empty() || bytes.len() as u64 > MAX_CHAT_IMAGE_BYTES {
        return Err("the generated image is empty or exceeds the 10 MB preview limit.".into());
    }
    let (_, extension) = validated_chat_media_type("generated", false, bytes)?;
    let session_id = parse_uuid(session_id)?.to_string();
    let lock = attachment_session_lock(&session_id)?;
    let _guard = lock
        .lock()
        .map_err(|_| "session attachment lock is unavailable".to_owned())?;
    let root = sessions_dir.join("attachments");
    ensure_private_attachment_directory(&root)?;
    let directory = root.join(session_id);
    ensure_private_attachment_directory(&directory)?;
    let hash = format!("{:x}", Sha256::digest(bytes));
    let destination = directory.join(format!("{hash}.{extension}"));
    ensure_attachment_storage_quota(&directory, &destination, bytes.len() as u64)?;
    write_private_attachment(&destination, bytes, &hash)?;
    Ok(destination)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chat_images;
    use serde_json::json;
    use std::fs;

    const PNG: &str = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";
    const SESSION: &str = "12345678-1234-1234-1234-123456789abc";

    fn image(id: &str) -> Value {
        json!({"type":"imageGeneration", "id":id, "status":"completed", "result":PNG})
    }

    fn preview(path: &Path, sessions: &Path) -> Option<PathBuf> {
        chat_images::resolve_cited_chat_image(
            url::Url::from_file_path(path).unwrap().as_str(),
            &chat_images::CitedImageContext {
                workspace: PathBuf::new(),
                provider_id: Some("openai".into()),
                provider_session_id: Some("codex-thread".into()),
                browser_captures: None,
                attachments: Some(sessions.join("attachments").join(SESSION)),
                home: None,
            },
        )
    }

    #[test]
    fn textless_generation_is_private_durable_and_previewable() {
        let temp = tempfile::tempdir().unwrap();
        let sessions = temp.path().join("sessions with spaces (nested (test)");
        fs::create_dir(&sessions).unwrap();
        let mut generated = GeneratedImages::default();
        assert_eq!(GeneratedImages::started(&image("one")).status, "running");
        let activity = generated
            .complete(&image("one"), &sessions, SESSION)
            .unwrap();
        assert_eq!(activity.status, "done");
        assert!(!format!("{activity:?}").contains(PNG));
        let path = &generated.images[0].0;
        assert_eq!(
            fs::read(path).unwrap(),
            base64::engine::general_purpose::STANDARD
                .decode(PNG)
                .unwrap()
        );
        assert_eq!(preview(path, &sessions), Some(path.canonicalize().unwrap()));
        let reply = generated.reply("");
        assert!(reply.starts_with("![Generated image](file:///"));
        assert!(reply.contains("%20"));
        assert!(reply.contains("%28"));
        assert!(!reply.contains(PNG));
        assert_eq!(
            generated.reply("Here it is."),
            format!("Here it is.\n\n{reply}")
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(path).unwrap().permissions().mode() & 0o777,
                0o600
            );
            assert_eq!(
                fs::metadata(path.parent().unwrap())
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o700
            );
        }
    }

    #[test]
    fn saved_path_only_is_copied_so_runner_cleanup_does_not_break_history() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("native output (one).png");
        fs::write(
            &source,
            base64::engine::general_purpose::STANDARD
                .decode(PNG)
                .unwrap(),
        )
        .unwrap();
        let item = json!({"type":"imageGeneration", "id":"one", "status":"completed", "result":"", "savedPath":source});
        let mut generated = GeneratedImages::default();
        assert_eq!(
            generated
                .complete(&item, temp.path(), SESSION)
                .unwrap()
                .status,
            "done"
        );
        fs::remove_file(&source).unwrap();
        let saved = &generated.images[0].0;
        assert_eq!(
            preview(saved, temp.path()),
            Some(saved.canonicalize().unwrap())
        );
        let own_caption = format!("![A cat]({})", source.display());
        let reply = generated.reply(&own_caption);
        assert!(reply.starts_with("![A cat](file:///"));
        assert_eq!(reply.matches("![").count(), 1);
        let own_url = format!("![A cat]({})", url::Url::from_file_path(source).unwrap());
        assert_eq!(generated.reply(&own_url), reply);
    }

    #[test]
    fn existing_file_url_citations_are_rewritten_without_corrupting_the_scheme() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("native.png");
        let mut item = image("one");
        item["savedPath"] = json!(source);
        let mut generated = GeneratedImages::default();
        generated.complete(&item, temp.path(), SESSION).unwrap();
        let original = format!("![A cat]({})", url::Url::from_file_path(&source).unwrap());
        let reply = generated.reply(&original);
        assert!(!reply.contains("file://file://"));
        assert_eq!(reply.matches("![").count(), 1);
        assert!(reply.contains(
            &generated.images[0]
                .0
                .file_name()
                .unwrap()
                .to_string_lossy()
                .to_string()
        ));
        // An empty savedPath must never be used as a global string replacement.
        item["id"] = json!("two");
        item["savedPath"] = json!("");
        generated.complete(&item, temp.path(), SESSION).unwrap();
        assert_eq!(generated.reply("Hello").matches("Hello").count(), 1);
    }

    #[test]
    fn replayed_items_and_identical_image_bytes_are_deduplicated() {
        let temp = tempfile::tempdir().unwrap();
        let mut generated = GeneratedImages::default();
        generated
            .complete(&image("one"), temp.path(), SESSION)
            .unwrap();
        assert!(generated
            .complete(&image("one"), temp.path(), SESSION)
            .is_none());
        generated
            .complete(&image("two"), temp.path(), SESSION)
            .unwrap();
        assert_eq!(generated.images.len(), 1);
        assert_eq!(generated.reply("").matches("![").count(), 1);
        assert_eq!(
            fs::read_dir(temp.path().join("attachments").join(SESSION))
                .unwrap()
                .count(),
            1
        );
    }

    #[test]
    fn failures_are_visible_and_do_not_save_images_or_claim_success() {
        let temp = tempfile::tempdir().unwrap();
        let mut generated = GeneratedImages::default();
        let mut item = image("limited");
        item["failure"] = json!({"type":"usageLimitExceeded", "limitId":"image_generation"});
        assert_eq!(
            generated
                .complete(&item, temp.path(), SESSION)
                .unwrap()
                .status,
            "failed"
        );
        assert!(generated.reply("").contains("usage limit"));
        assert!(generated.images.is_empty());
        assert!(!temp.path().join("attachments").exists());
        item = image("failed");
        item["status"] = json!("failed");
        assert_eq!(
            generated
                .complete(&item, temp.path(), SESSION)
                .unwrap()
                .status,
            "failed"
        );
        assert!(generated
            .reply("The provider failed.")
            .contains("did not complete"));
    }

    #[test]
    fn malformed_missing_and_oversized_payloads_fail_without_storing_them() {
        let temp = tempfile::tempdir().unwrap();
        for (id, result) in [
            ("invalid", "not an image".to_owned()),
            ("empty", String::new()),
            (
                "large",
                "A".repeat((MAX_CHAT_IMAGE_BYTES as usize).div_ceil(3) * 4 + 4),
            ),
            (
                "wrong-type",
                base64::engine::general_purpose::STANDARD.encode("not an image"),
            ),
        ] {
            let mut generated = GeneratedImages::default();
            let item = json!({"id":id,"status":"completed","result":result});
            assert_eq!(
                generated
                    .complete(&item, temp.path(), SESSION)
                    .unwrap()
                    .status,
                "failed"
            );
            assert!(generated.images.is_empty());
            assert!(!generated.reply("").is_empty());
        }
        assert!(!temp.path().join("attachments").exists());
    }

    #[test]
    fn saved_files_are_bounded_and_symlinks_are_rejected() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("large.png");
        let file = fs::File::create(&source).unwrap();
        file.set_len(MAX_CHAT_IMAGE_BYTES + 1).unwrap();
        let item = json!({"id":"one","status":"completed","result":"","savedPath":source});
        let mut generated = GeneratedImages::default();
        assert_eq!(
            generated
                .complete(&item, temp.path(), SESSION)
                .unwrap()
                .status,
            "failed"
        );
        #[cfg(unix)]
        {
            let link = temp.path().join("link.png");
            std::os::unix::fs::symlink(&source, &link).unwrap();
            let item = json!({"id":"two","status":"completed","result":"","savedPath":link});
            assert_eq!(
                generated
                    .complete(&item, temp.path(), SESSION)
                    .unwrap()
                    .status,
                "failed"
            );
            assert!(generated.reply("").contains("could not be read"));
        }
        assert!(!temp.path().join("attachments").exists());
    }

    #[test]
    fn generated_images_stay_inside_their_own_session() {
        let temp = tempfile::tempdir().unwrap();
        let mut generated = GeneratedImages::default();
        assert_eq!(
            generated
                .complete(&image("unsafe"), temp.path(), "../escape")
                .unwrap()
                .status,
            "failed"
        );
        assert!(!temp.path().join("attachments").exists());
        #[cfg(unix)]
        {
            let elsewhere = tempfile::tempdir().unwrap();
            std::os::unix::fs::symlink(elsewhere.path(), temp.path().join("attachments")).unwrap();
            assert_eq!(
                generated
                    .complete(&image("symlink"), temp.path(), SESSION)
                    .unwrap()
                    .status,
                "failed"
            );
            assert_eq!(fs::read_dir(elsewhere.path()).unwrap().count(), 0);
        }
    }

    #[test]
    fn active_turn_scope_and_planning_policy_are_preserved() {
        let params = json!({"threadId":"thread","turnId":"turn"});
        assert!(GeneratedImages::accepts(&params, "thread", Some("turn")));
        assert!(!GeneratedImages::accepts(&params, "other", Some("turn")));
        assert!(!GeneratedImages::accepts(
            &params,
            "thread",
            Some("previous")
        ));
        assert!(!GeneratedImages::accepts(&params, "thread", None));
        assert!(!GeneratedImages::accepts(
            &json!({}),
            "thread",
            Some("turn")
        ));
        assert_eq!(
            config_arg(&ChatMode::Normal),
            "features.image_generation=true"
        );
        assert_eq!(
            config_arg(&ChatMode::Plan),
            "features.image_generation=false"
        );
        assert_eq!(
            config_arg(&ChatMode::Council),
            "features.image_generation=false"
        );
    }

    #[test]
    fn long_text_keeps_the_generated_image_within_the_reply_budget() {
        let temp = tempfile::tempdir().unwrap();
        let mut generated = GeneratedImages::default();
        generated
            .complete(&image("one"), temp.path(), SESSION)
            .unwrap();
        let reply = generated.reply(&"a".repeat(MAX_CHAT_RESPONSE_CHARS));
        assert!(reply.chars().count() <= MAX_CHAT_RESPONSE_CHARS);
        assert!(reply.contains("![Generated image]"));
        assert!(reply.ends_with(')'));
    }
}
