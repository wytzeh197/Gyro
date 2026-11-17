use gyro_core::provider_runtime::{
    limits::MAX_CHAT_IMAGE_BYTES, runners::openai_compatible::user_content,
    support::claude_multimodal_input, types::ChatAttachmentRequest,
};
use sha2::{Digest, Sha256};
use std::{fs, path::Path};

fn attachment(path: &Path, size: u64, hash: Option<String>) -> ChatAttachmentRequest {
    ChatAttachmentRequest {
        id: "fixture".into(),
        kind: "image".into(),
        name: "fixture.png".into(),
        path: path.to_string_lossy().into_owned(),
        relative_path: None,
        mime_type: Some("image/png".into()),
        size,
        content_hash: hash,
        modified_at: None,
        preview_url: None,
    }
}

type Build = fn(&str, &[ChatAttachmentRequest]) -> anyhow::Result<serde_json::Value>;
fn oversized_is_rejected(build: Build) {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("oversized.png");
    fs::File::create(&path)
        .unwrap()
        .set_len(MAX_CHAT_IMAGE_BYTES + 1)
        .unwrap();
    assert!(
        build(
            "prompt",
            &[attachment(&path, MAX_CHAT_IMAGE_BYTES + 1, None)]
        )
        .is_err(),
        "provider payload creation must enforce the image byte limit"
    );
}
fn changed_bytes_are_rejected(build: Build) {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("changed.png");
    let hash = format!("{:x}", Sha256::digest(b"original"));
    let attached = attachment(&path, 8, Some(hash));
    fs::write(&path, b"replaced").unwrap();
    assert!(
        build("prompt", &[attached]).is_err(),
        "provider payload creation must verify the bytes it actually reads"
    );
}

#[test]
fn openai_payload_rejects_oversized_images() {
    oversized_is_rejected(user_content);
}
#[test]
fn claude_payload_rejects_oversized_images() {
    oversized_is_rejected(claude_multimodal_input);
}
#[test]
fn openai_payload_rejects_same_size_replaced_images() {
    changed_bytes_are_rejected(user_content);
}
#[test]
fn claude_payload_rejects_same_size_replaced_images() {
    changed_bytes_are_rejected(claude_multimodal_input);
}

#[test]
fn provider_payloads_retain_verified_image_bytes_and_prompt() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("image.png");
    fs::write(&path, b"original").unwrap();
    let attached = attachment(&path, 8, Some(format!("{:x}", Sha256::digest(b"original"))));
    let openai = user_content("prompt", std::slice::from_ref(&attached)).unwrap();
    assert_eq!(openai[0]["text"], "prompt");
    assert_eq!(
        openai[1]["image_url"]["url"],
        "data:image/png;base64,b3JpZ2luYWw="
    );
    let claude = claude_multimodal_input("prompt", &[attached]).unwrap();
    assert_eq!(claude["message"]["content"][0]["text"], "prompt");
    assert_eq!(
        claude["message"]["content"][1]["source"]["data"],
        "b3JpZ2luYWw="
    );
}
