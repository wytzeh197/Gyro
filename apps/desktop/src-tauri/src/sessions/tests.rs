use super::*;

#[test]
fn provider_approval_nonce_is_bound_to_the_active_session_run() {
    let session_id = Uuid::new_v4().to_string();
    let control = Arc::new(ProviderRunControl::default());
    let expected_nonce = control.approval_nonce.clone();
    let flags = HashMap::from([(session_id.clone(), control)]);

    assert!(provider_run_approval_matches(
        &flags,
        &session_id,
        &expected_nonce
    ));
    assert!(!provider_run_approval_matches(
        &flags,
        &session_id,
        "forged-nonce"
    ));
    assert!(!provider_run_approval_matches(&flags, &session_id, ""));
    assert!(!provider_run_approval_matches(
        &flags,
        "another-session",
        &expected_nonce
    ));
}

#[test]
fn session_takes_full_size_images_until_the_byte_budget_runs_out() {
    let root = tempfile::tempdir().unwrap();
    let mut accepted = 0_u64;
    let error = loop {
        let path = root.path().join(format!("{accepted}.png"));
        match ensure_attachment_storage_quota(root.path(), &path, MAX_CHAT_IMAGE_BYTES) {
            Ok(()) => sized_attachment(&path, MAX_CHAT_IMAGE_BYTES),
            Err(error) => break error,
        }
        accepted += 1;
    };

    assert_eq!(
        accepted,
        MAX_STORED_CHAT_ATTACHMENT_BYTES_PER_SESSION / MAX_CHAT_IMAGE_BYTES
    );
    assert!(error.contains("1 GB"), "{error}");
    assert!(error.contains("new chat"), "{error}");
    assert_eq!(
        std::fs::read_dir(root.path()).unwrap().count() as u64,
        accepted,
        "a session's files must survive a refused attachment"
    );
}

#[test]
fn full_session_can_take_a_smaller_file_or_one_it_already_stores() {
    let root = tempfile::tempdir().unwrap();
    let stored = root.path().join("stored.mov");
    sized_attachment(&stored, MAX_STORED_CHAT_ATTACHMENT_BYTES_PER_SESSION - 1);
    let next = root.path().join("next.png");

    ensure_attachment_storage_quota(root.path(), &stored, 1 << 20).unwrap();
    ensure_attachment_storage_quota(root.path(), &next, 1).unwrap();
    assert!(ensure_attachment_storage_quota(root.path(), &next, 2).is_err());
}
