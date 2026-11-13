use super::*;

#[test]
fn observation_waits_for_headers_agent_and_dom_but_not_images() {
    for method in ["status", "readPage", "find"] {
        let manager = SessionBrowserManager::default();
        manager
            .inner
            .lock()
            .unwrap()
            .insert("chat".into(), browser_slot("chat", false));
        let (resource, _) = manager.capture_resource("chat").unwrap();
        manager
            .reserve_navigation(&resource, Some("https://next.example/"))
            .unwrap();
        let mut probes = 0;
        let mut reads = 0;
        std::thread::scope(|threads| {
            threads.spawn(|| {
                std::thread::sleep(Duration::from_millis(30));
                manager
                    .commit_navigation(&resource, "https://next.example/")
                    .unwrap();
            });
            let result = manager
                .observe_document(
                    "chat",
                    method,
                    serde_json::json!({"maxDepth":3}),
                    |lease, snapshot, action, args| {
                        lease.validate(&manager)?;
                        assert_eq!(snapshot.url, "https://next.example/");
                        assert!(
                            snapshot.loading,
                            "subresources are deliberately still loading"
                        );
                        if action == "status" {
                            probes += 1;
                            match probes {
                                1 => Err("browser agent is not ready".into()),
                                2 => Ok(serde_json::json!({"readyState":"loading"})),
                                _ => Ok(serde_json::json!({"readyState":"interactive"})),
                            }
                        } else {
                            reads += 1;
                            assert_eq!(action, method);
                            assert_eq!(args["maxDepth"], 3);
                            Ok(serde_json::json!({"ok":true}))
                        }
                    },
                )
                .unwrap();
            assert_eq!(probes, 3);
            assert_eq!(reads, usize::from(method != "status"));
            assert!(result.is_object());
        });
    }
}

#[test]
fn observation_never_retries_actions_or_non_readiness_errors() {
    let manager = SessionBrowserManager::default();
    manager
        .inner
        .lock()
        .unwrap()
        .insert("chat".into(), browser_slot("chat", false));
    let mut dispatched = 0;
    let error = manager
        .observe_document("chat", "click", Value::Null, |_, _, _, _| {
            dispatched += 1;
            Ok(Value::Null)
        })
        .unwrap_err();
    assert!(error.contains("cannot dispatch"));
    assert_eq!(dispatched, 0);
    let error = manager
        .observe_document("chat", "readPage", Value::Null, |_, _, _, _| {
            dispatched += 1;
            Err("browser agent call timed out".into())
        })
        .unwrap_err();
    assert_eq!(error, "browser agent call timed out");
    assert_eq!(
        dispatched, 1,
        "a timed-out evaluation is not blindly repeated"
    );
}

#[test]
fn observation_rejects_navigation_changes_before_reading() {
    let manager = SessionBrowserManager::default();
    manager
        .inner
        .lock()
        .unwrap()
        .insert("chat".into(), browser_slot("chat", false));
    let mut dispatched = Vec::new();
    let result =
        manager.observe_document("chat", "readPage", Value::Null, |lease, _, action, _| {
            dispatched.push(action.to_owned());
            manager.reserve_navigation(&lease.resource, Some("https://other.example/"))?;
            Ok(serde_json::json!({"readyState":"complete"}))
        });
    assert!(result.is_err());
    assert_eq!(dispatched, ["status"]);
}

#[test]
fn observation_stop_during_readiness_prevents_the_read() {
    let manager = SessionBrowserManager::default();
    manager
        .inner
        .lock()
        .unwrap()
        .insert("chat".into(), browser_slot("chat", false));
    let cancellation = gyro_core::CancellationToken::default();
    let _scope = begin_model_operation(
        gyro_core::CapabilityId::BrowserReadPage,
        cancellation.clone(),
    )
    .unwrap();
    let mut dispatched = Vec::new();
    let result = manager.observe_document("chat", "readPage", Value::Null, |_, _, action, _| {
        dispatched.push(action.to_owned());
        cancellation.cancel();
        Ok(serde_json::json!({"readyState":"complete"}))
    });
    assert!(operation_was_cancelled(&result.unwrap_err()));
    assert_eq!(dispatched, ["status"]);
}

#[test]
fn observation_readiness_has_a_deadline() {
    let manager = SessionBrowserManager::default();
    manager
        .inner
        .lock()
        .unwrap()
        .insert("chat".into(), browser_slot("chat", false));
    let started = Instant::now();
    let result = manager.observe_document("chat", "readPage", Value::Null, |_, _, action, _| {
        assert_eq!(action, "status");
        Ok(serde_json::json!({"readyState":"loading"}))
    });
    assert!(result.unwrap_err().contains("not ready for observation"));
    assert!(started.elapsed() < Duration::from_secs(10));
}

#[test]
fn screenshot_waits_for_its_document_and_rejects_superseded_navigation() {
    let manager = SessionBrowserManager::default();
    manager
        .inner
        .lock()
        .unwrap()
        .insert("chat".into(), browser_slot("chat", false));
    let (lease, _) = manager.capture_resource("chat").unwrap();
    manager
        .reserve_navigation(&lease, Some("https://next.example/"))
        .unwrap();
    std::thread::scope(|scope| {
        scope.spawn(|| {
            std::thread::sleep(Duration::from_millis(60));
            manager
                .commit_navigation(&lease, "https://next.example/")
                .unwrap();
        });
        assert!(
            manager
                .wait_for_document("chat")
                .unwrap()
                .document_committed
        );
    });
    manager.reserve_navigation(&lease, None).unwrap();
    std::thread::scope(|scope| {
        scope.spawn(|| {
            std::thread::sleep(Duration::from_millis(60));
            manager.reserve_navigation(&lease, None).unwrap();
        });
        assert!(manager
            .wait_for_document("chat")
            .unwrap_err()
            .contains("navigation changed"));
    });
}

#[test]
fn screenshot_navigation_wait_is_cancelable_and_rejects_reopened_browsers() {
    let manager = SessionBrowserManager::default();
    manager
        .inner
        .lock()
        .unwrap()
        .insert("chat".into(), browser_slot("chat", false));
    let (lease, _) = manager.capture_resource("chat").unwrap();
    manager.reserve_navigation(&lease, None).unwrap();
    let cancel = gyro_core::CancellationToken::default();
    let scope =
        begin_model_operation(gyro_core::CapabilityId::BrowserScreenshot, cancel.clone()).unwrap();
    std::thread::scope(|threads| {
        threads.spawn(|| {
            std::thread::sleep(Duration::from_millis(60));
            cancel.cancel();
        });
        assert!(manager.wait_for_document("chat").is_err());
    });
    drop(scope);
    std::thread::scope(|threads| {
        threads.spawn(|| {
            std::thread::sleep(Duration::from_millis(60));
            manager
                .inner
                .lock()
                .unwrap()
                .insert("chat".into(), browser_slot("chat", false));
        });
        assert!(manager.wait_for_document("chat").is_err());
    });
}

#[test]
fn undispatched_requests_restore_known_documents_but_not_superseded_pending_work() {
    let manager = SessionBrowserManager::default();
    manager
        .inner
        .lock()
        .unwrap()
        .insert("chat".into(), browser_slot("chat", false));
    let (lease, initial) = manager.capture_resource("chat").unwrap();
    let first = manager
        .reserve_navigation(&lease, Some("https://first.example/"))
        .unwrap();
    let second = manager
        .reserve_navigation(&lease, Some("https://second.example/"))
        .unwrap();
    manager.restore_undispatched_navigation(&first, true);
    let current = manager.get_snapshot("chat").unwrap().unwrap();
    assert_eq!(current.navigation_id, second.navigation_id);
    assert_eq!(current.url, "https://second.example/");
    manager.restore_undispatched_navigation(&second, true);
    let current = manager.get_snapshot("chat").unwrap().unwrap();
    assert!(!current.loading && !current.document_committed);
    assert_eq!(current.navigation_error.as_ref().unwrap().kind, "cancelled");
    assert!(manager.capture_document("chat").is_err());
    assert!(manager
        .recover_provisional_document(&lease, current.navigation_id)
        .unwrap());
    assert_eq!(manager.capture_document("chat").unwrap().1.url, initial.url);
    let request = manager
        .reserve_navigation(&lease, Some("https://next.example/"))
        .unwrap();
    manager.restore_undispatched_navigation(&request, true);
    let restored = manager.capture_document("chat").unwrap().1;
    assert_eq!(restored.url, initial.url);
    assert!(restored.navigation_id > current.navigation_id);
    let replacement = browser_slot("chat", false);
    let replacement_id = replacement.resource_id.clone();
    manager
        .inner
        .lock()
        .unwrap()
        .insert("chat".into(), replacement);
    manager.restore_undispatched_navigation(&request, true);
    assert_eq!(
        manager.get_snapshot("chat").unwrap().unwrap().resource_id,
        replacement_id
    );
}

#[cfg(target_os = "macos")]
#[test]
fn restoring_an_undispatched_request_keeps_the_original_native_finish_token() {
    use navigation_observer::NavigationEvent as Event;
    let manager = SessionBrowserManager::default();
    manager
        .inner
        .lock()
        .unwrap()
        .insert("chat".into(), browser_slot("chat", false));
    let (lease, initial) = manager.capture_resource("chat").unwrap();
    manager
        .native_navigation_event(&lease, 10, &Event::Started, Some(&initial.url))
        .unwrap();
    manager
        .native_navigation_event(&lease, 10, &Event::Committed, Some(&initial.url))
        .unwrap();
    let request = manager
        .reserve_navigation(&lease, Some("https://next.example/"))
        .unwrap();
    manager.restore_undispatched_navigation(&request, true);
    assert!(manager.capture_document("chat").unwrap().1.loading);
    manager
        .native_navigation_event(&lease, 10, &Event::Finished, Some(&initial.url))
        .unwrap();
    assert!(!manager.capture_document("chat").unwrap().1.loading);
}
#[cfg(target_os = "macos")]
#[test]
fn native_navigation_callbacks_cannot_settle_a_replacement_request() {
    use navigation_observer::NavigationEvent as Event;
    let manager = SessionBrowserManager::default();
    manager
        .inner
        .lock()
        .unwrap()
        .insert("chat".into(), browser_slot("chat", false));
    let (lease, initial) = manager.capture_resource("chat").unwrap();
    manager
        .native_navigation_event(&lease, 10, &Event::Started, Some(&initial.url))
        .unwrap();
    manager
        .native_navigation_event(&lease, 10, &Event::Committed, Some(&initial.url))
        .unwrap();
    // Same-URL reload: URL checks alone cannot identify the old callback.
    let next = manager
        .start_navigation(&lease, Some(&initial.url))
        .unwrap();
    for event in [
        Event::Failed {
            cancelled: true,
            code: -999,
            provisional: true,
        },
        Event::Committed,
        Event::Finished,
    ] {
        assert!(manager
            .native_navigation_event(&lease, 10, &event, Some(&initial.url))
            .unwrap()
            .is_none());
    }
    let waiting = manager.get_snapshot("chat").unwrap().unwrap();
    assert_eq!(waiting.navigation_id, next);
    assert!(waiting.loading && !waiting.document_committed && waiting.navigation_error.is_none());
    assert!(manager.capture_document("chat").is_err());
    manager
        .native_navigation_event(&lease, 20, &Event::Started, Some(&initial.url))
        .unwrap();
    manager
        .native_navigation_event(&lease, 20, &Event::Committed, Some(&initial.url))
        .unwrap();
    manager
        .native_navigation_event(
            &lease,
            10,
            &Event::Failed {
                cancelled: true,
                code: -999,
                provisional: true,
            },
            Some(&initial.url),
        )
        .unwrap();
    assert!(manager.capture_document("chat").is_ok());
    manager
        .native_navigation_event(&lease, 20, &Event::Finished, Some(&initial.url))
        .unwrap();
    assert!(!manager.get_snapshot("chat").unwrap().unwrap().loading);
}

#[cfg(target_os = "macos")]
#[test]
fn failed_navigation_only_recovers_a_previous_provisional_document() {
    use navigation_observer::NavigationEvent as Event;
    let manager = SessionBrowserManager::default();
    manager
        .inner
        .lock()
        .unwrap()
        .insert("chat".into(), browser_slot("chat", false));
    let (lease, initial) = manager.capture_resource("chat").unwrap();
    manager
        .native_navigation_event(&lease, 10, &Event::Started, Some("https://failed.example/"))
        .unwrap();
    manager
        .native_navigation_event(
            &lease,
            10,
            &Event::Failed {
                cancelled: false,
                code: -1005,
                provisional: true,
            },
            Some(&initial.url),
        )
        .unwrap();
    let failed = manager.get_snapshot("chat").unwrap().unwrap();
    assert!(!failed.loading && !failed.document_committed);
    assert!(manager
        .capture_document("chat")
        .err()
        .unwrap()
        .contains("navigation failed"));
    assert!(manager
        .recover_provisional_document(&lease, failed.navigation_id)
        .unwrap());
    let (_, recovered) = manager.capture_document("chat").unwrap();
    assert_eq!(recovered.url, initial.url);
    assert!(recovered.navigation_id > failed.navigation_id && recovered.navigation_error.is_none());
    manager
        .native_navigation_event(
            &lease,
            10,
            &Event::Finished,
            Some("https://failed.example/"),
        )
        .unwrap();
    assert_eq!(
        manager.get_snapshot("chat").unwrap().unwrap().url,
        initial.url
    );
    manager
        .native_navigation_event(
            &lease,
            20,
            &Event::Started,
            Some("https://partial.example/"),
        )
        .unwrap();
    manager
        .native_navigation_event(
            &lease,
            20,
            &Event::Committed,
            Some("https://partial.example/"),
        )
        .unwrap();
    manager
        .native_navigation_event(
            &lease,
            20,
            &Event::Failed {
                cancelled: false,
                code: -1005,
                provisional: false,
            },
            Some("https://partial.example/"),
        )
        .unwrap();
    let partial = manager.get_snapshot("chat").unwrap().unwrap();
    assert!(!manager
        .recover_provisional_document(&lease, partial.navigation_id)
        .unwrap());
    assert!(manager.capture_document("chat").is_err());
}
#[test]
fn native_provisional_start_invalidates_a_page_document_once() {
    let manager = SessionBrowserManager::default();
    manager
        .inner
        .lock()
        .unwrap()
        .insert("chat".into(), browser_slot("chat", false));
    let (old, initial) = manager.capture_document("chat").unwrap();
    manager
        .start_native_navigation(&old.resource, Some("https://next.example/"))
        .unwrap();
    let pending = manager.get_snapshot("chat").unwrap().unwrap();
    assert!(pending.loading && !pending.document_committed);
    assert_eq!(pending.navigation_id, initial.navigation_id + 1);
    assert_eq!(pending.url, "https://next.example/");
    assert!(old.validate(&manager).is_err());
    manager
        .start_native_navigation(&old.resource, Some("https://next.example/redirect"))
        .unwrap();
    assert_eq!(
        manager.get_snapshot("chat").unwrap().unwrap().navigation_id,
        pending.navigation_id
    );
    manager
        .commit_navigation(&old.resource, "https://next.example/redirect")
        .unwrap();
    assert!(manager.capture_document("chat").is_ok());
}

#[test]
fn native_start_keeps_an_explicit_requests_navigation_identity() {
    let manager = SessionBrowserManager::default();
    manager
        .inner
        .lock()
        .unwrap()
        .insert("chat".into(), browser_slot("chat", false));
    let (old, _) = manager.capture_document("chat").unwrap();
    let id = manager
        .start_navigation(&old.resource, Some("https://next.example/"))
        .unwrap();
    manager
        .start_native_navigation(&old.resource, Some("https://next.example/"))
        .unwrap();
    assert_eq!(
        manager.get_snapshot("chat").unwrap().unwrap().navigation_id,
        id
    );
    assert_eq!(
        manager
            .commit_navigation(&old.resource, "https://next.example/")
            .unwrap(),
        id
    );
}

#[test]
fn initial_page_reconciliation_cannot_commit_blank_or_superseded_documents() {
    let manager = SessionBrowserManager::default();
    let mut slot = browser_slot("chat", false);
    slot.document_committed = false;
    manager.inner.lock().unwrap().insert("chat".into(), slot);
    let (resource, snapshot) = manager.capture_resource("chat").unwrap();
    let lease = BrowserDocumentLease {
        resource,
        navigation_id: snapshot.navigation_id,
    };
    assert!(!manager
        .reconcile_initial_document(
            &lease,
            &serde_json::json!({"installed":true,"url":"about:blank","readyState":"complete"})
        )
        .unwrap());
    let observed = serde_json::json!({"installed":true,"url":"https://fast.example/","readyState":"complete","title":"Fast"});
    assert!(manager
        .reconcile_initial_document(&lease, &observed)
        .unwrap());
    assert!(!manager.capture_document("chat").unwrap().1.loading);
    manager
        .start_navigation(&lease.resource, Some("https://next.example/"))
        .unwrap();
    assert!(!manager
        .reconcile_initial_document(&lease, &observed)
        .unwrap());
    assert!(
        !manager
            .get_snapshot("chat")
            .unwrap()
            .unwrap()
            .document_committed
    );
    assert_eq!(
        manager.get_snapshot("chat").unwrap().unwrap().url,
        "https://next.example/"
    );
}

#[test]
fn document_tools_wait_for_commit_but_not_for_all_page_resources() {
    let manager = SessionBrowserManager::default();
    manager
        .inner
        .lock()
        .unwrap()
        .insert("chat".into(), browser_slot("chat", false));
    let (old, initial) = manager.capture_document("chat").unwrap();
    assert!(
        initial.loading,
        "an interactive document can still be loading images"
    );
    let next = manager
        .start_navigation(&old.resource, Some("https://next.example/"))
        .unwrap();
    assert!(manager.capture_document("chat").is_err());
    assert!(old.validate(&manager).is_err());
    assert!(manager
        .with_document_mut(&old, |slot| slot.url = "https://old.example/".into())
        .is_err());
    assert!(manager
        .update_resource_state(&old.resource, None, Some("Old title"))
        .is_err());
    let pending = manager.get_snapshot("chat").unwrap().unwrap();
    assert_eq!(pending.url, "https://next.example/");
    assert!(pending.title.is_empty());
    assert!(!pending.document_committed);
    assert_eq!(
        manager
            .commit_navigation(&old.resource, "https://next.example/")
            .unwrap(),
        next
    );
    let (current, snapshot) = manager.capture_document("chat").unwrap();
    assert!(snapshot.loading && snapshot.document_committed);
    assert!(current.validate(&manager).is_ok());
    assert!(old.validate(&manager).is_err());
}

#[test]
fn a_capture_cannot_be_registered_after_same_url_reload_or_page_navigation() {
    let manager = SessionBrowserManager::default();
    manager
        .inner
        .lock()
        .unwrap()
        .insert("chat".into(), browser_slot("chat", false));
    let (old, initial) = manager.capture_document("chat").unwrap();
    manager.start_navigation(&old.resource, None).unwrap();
    assert!(manager
        .remember_pointer_capture_at_navigation(
            "chat",
            old.navigation_id,
            "old.png".into(),
            initial.url.clone(),
            serde_json::json!({})
        )
        .is_err());
    manager
        .commit_navigation(&old.resource, &initial.url)
        .unwrap();
    assert!(manager
        .remember_pointer_capture_at_navigation(
            "chat",
            old.navigation_id,
            "old.png".into(),
            initial.url.clone(),
            serde_json::json!({})
        )
        .is_err());
    let (current, _) = manager.capture_document("chat").unwrap();
    manager
        .remember_pointer_capture_at_navigation(
            "chat",
            current.navigation_id,
            "new.png".into(),
            initial.url.clone(),
            serde_json::json!({}),
        )
        .unwrap();
    assert!(manager.pointer_reference("chat", "new.png").is_ok());
    manager
        .commit_navigation(&old.resource, "https://link.example/")
        .unwrap();
    assert!(current.validate(&manager).is_err());
    assert!(manager.pointer_reference("chat", "new.png").is_err());
}

#[test]
fn loading_state_belongs_to_the_current_navigation_even_for_same_url_reload() {
    let manager = SessionBrowserManager::default();
    manager
        .inner
        .lock()
        .unwrap()
        .insert("chat".into(), browser_slot("chat", false));
    let (lease, initial) = manager.capture_resource("chat").unwrap();
    assert!(initial.loading);
    let finished = manager.finish_navigation(&lease, &initial.url).unwrap();
    assert!(manager.navigation_is_finished(&lease, finished));
    manager.set_title("chat", "Previous").unwrap();
    manager
        .remember_pointer_capture(
            "chat",
            "old".into(),
            initial.url.clone(),
            serde_json::json!({}),
        )
        .unwrap();
    let reload = manager.start_navigation(&lease, None).unwrap();
    assert!(reload > finished);
    assert!(!manager.navigation_is_finished(&lease, finished));
    let pending = manager.get_snapshot("chat").unwrap().unwrap();
    assert!(pending.loading);
    assert!(pending.title.is_empty());
    assert_eq!(pending.url, initial.url);
    assert!(manager.pointer_reference("chat", "old").is_err());
    let next = manager
        .finish_navigation(&lease, "https://example.com/redirect")
        .unwrap();
    assert_eq!(next, reload);
    assert!(manager.navigation_is_finished(&lease, next));
    assert!(!manager.get_snapshot("chat").unwrap().unwrap().loading);
}

#[test]
fn failed_navigation_request_restores_state_without_undoing_newer_callbacks() {
    let manager = SessionBrowserManager::default();
    manager
        .inner
        .lock()
        .unwrap()
        .insert("chat".into(), browser_slot("chat", false));
    let (lease, initial) = manager.capture_resource("chat").unwrap();
    manager.finish_navigation(&lease, &initial.url).unwrap();
    manager.set_title("chat", "Previous").unwrap();
    let previous = manager.get_snapshot("chat").unwrap().unwrap();
    let failed = manager
        .start_navigation(&lease, Some("https://bad.example/"))
        .unwrap();
    manager.restore_navigation(&lease, failed, &previous);
    let restored = manager.get_snapshot("chat").unwrap().unwrap();
    assert_eq!(restored.url, previous.url);
    assert_eq!(restored.title, previous.title);
    assert!(!restored.loading);
    let failed = manager
        .start_navigation(&lease, Some("https://bad.example/"))
        .unwrap();
    manager
        .start_navigation(&lease, Some("https://new.example/"))
        .unwrap();
    manager.restore_navigation(&lease, failed, &previous);
    let current = manager.get_snapshot("chat").unwrap().unwrap();
    assert_eq!(current.url, "https://new.example/");
    assert!(current.loading);
}

#[test]
fn late_browser_results_cannot_update_a_replacement_resource() {
    let manager = SessionBrowserManager::default();
    manager
        .inner
        .lock()
        .unwrap()
        .insert("chat".into(), browser_slot("chat", false));
    let (old, _) = manager.capture_resource("chat").unwrap();
    let mut replacement = browser_slot("chat", false);
    replacement.title = "Replacement".into();
    let resource_id = replacement.resource_id.clone();
    manager
        .inner
        .lock()
        .unwrap()
        .insert("chat".into(), replacement);
    manager
        .remember_pointer_capture(
            "chat",
            "new-capture".into(),
            "https://example.com/".into(),
            serde_json::json!({}),
        )
        .unwrap();
    assert!(old.validate(&manager).is_err());
    assert!(manager
        .update_resource_state(&old, Some("https://old.example/"), Some("Old title"))
        .is_err());
    assert!(manager
        .push_console(
            &old,
            BrowserConsoleEntry {
                kind: "log".into(),
                message: "old page".into(),
                source: None,
                line: None,
                column: None,
            }
        )
        .is_err());
    assert!(manager
        .push_network(
            &old,
            BrowserNetworkEntry {
                method: "GET".into(),
                url: "https://old.example/".into(),
                status: Some(200),
                ok: Some(true),
                resource_type: None,
            }
        )
        .is_err());
    assert!(manager
        .with_resource_mut(&old, |slot| {
            slot.host_bounds.width = 1.0;
        })
        .is_err());
    let snapshot = manager.get_snapshot("chat").unwrap().unwrap();
    assert_eq!(snapshot.resource_id, resource_id);
    assert_eq!(snapshot.url, "https://example.com/");
    assert_eq!(snapshot.title, "Replacement");
    assert!(manager.console_entries("chat", 20).unwrap().is_empty());
    assert!(manager.inner.lock().unwrap()["chat"].network.is_empty());
    assert!(manager.pointer_reference("chat", "new-capture").is_ok());
    let (current, _) = manager.capture_resource("chat").unwrap();
    manager
        .update_resource_state(
            &current,
            Some("https://new.example/"),
            Some("Current title"),
        )
        .unwrap();
    assert_eq!(
        manager.get_snapshot("chat").unwrap().unwrap().title,
        "Current title"
    );
    assert!(manager.pointer_reference("chat", "new-capture").is_err());
    manager.remove_slot("chat").unwrap();
    assert!(current.validate(&manager).is_err());
}

#[test]
fn model_tool_cannot_attach_an_old_capture_to_a_reopened_browser() {
    let manager = SessionBrowserManager::default();
    manager
        .inner
        .lock()
        .unwrap()
        .insert("chat".into(), browser_slot("chat", false));
    let scope = begin_model_operation(
        gyro_core::CapabilityId::BrowserScreenshot,
        gyro_core::CancellationToken::default(),
    )
    .unwrap();
    manager.capture_resource("chat").unwrap();
    manager
        .inner
        .lock()
        .unwrap()
        .insert("chat".into(), browser_slot("chat", false));
    assert!(manager.capture_resource("chat").is_err());
    assert!(manager
        .remember_pointer_capture(
            "chat",
            "old".into(),
            "https://example.com/".into(),
            serde_json::json!({})
        )
        .is_err());
    assert!(manager.inner.lock().unwrap()["chat"]
        .pointer_reference
        .is_none());
    drop(scope);
    assert!(manager.capture_resource("chat").is_ok());
}

#[test]
fn a_browser_visibility_change_gives_the_keyboard_back_to_the_chat() {
    // Showing or hiding the child webview moves first responder in the
    // window, so the app webview has to reclaim it or keystrokes stop
    // reaching the chat the user is typing in.
    assert!(visibility_moves_keyboard_focus(false, true));
    assert!(visibility_moves_keyboard_focus(true, false));
    // Re-sending the state the browser is already in must leave typing alone.
    assert!(!visibility_moves_keyboard_focus(true, true));
    assert!(!visibility_moves_keyboard_focus(false, false));
}

fn browser_slot(session_id: &str, background_only: bool) -> SessionBrowserSlot {
    SessionBrowserSlot {
        session_id: session_id.into(),
        workspace_key: "shared-workspace".into(),
        resource_id: Uuid::new_v4().to_string(),
        webview_label: format!("session-browser-{session_id}"),
        bridge_nonce: Uuid::new_v4().to_string(),
        url: "https://example.com/".into(),
        title: String::new(),
        loading: true,
        navigation_id: 1,
        document_committed: true,
        navigation_error: None,
        native_navigation_token: None,
        committed_url: Some("https://example.com/".into()),
        failed_provisional: false,
        visible: false,
        background_only,
        host_bounds: BACKGROUND_BROWSER_BOUNDS.clone(),
        viewport_request: BrowserViewportRequest::default(),
        viewport: browser_viewport::geometry(
            BrowserViewportRequest::default(),
            "https://example.com/",
            &BACKGROUND_BROWSER_BOUNDS,
        )
        .unwrap()
        .state,
        approved_origins: HashSet::new(),
        pointer_reference: None,
        console: VecDeque::new(),
        network: VecDeque::new(),
    }
}

#[test]
fn pre_chat_workbench_owners_are_validated_separately_from_model_chats() {
    let request = |session_id: &str, workspace_key: &str| SessionBrowserOpenRequest {
        session_id: session_id.into(),
        workspace_key: workspace_key.into(),
        url: "http://127.0.0.1:4319/".into(),
        bounds: None,
        visible: Some(true),
    };
    assert_eq!(
        is_workbench_browser_request(&request("workbench", "")).unwrap(),
        true
    );
    let workspace = "/tmp/Project with spaces/é";
    assert_eq!(
        is_workbench_browser_request(&request(&format!("workbench:{workspace}"), workspace))
            .unwrap(),
        true
    );
    for (owner, workspace) in [
        ("workbench", "/tmp/project"),
        ("workbench:", ""),
        ("workbench:relative", "relative"),
        ("workbench:/tmp/a", "/tmp/b"),
    ] {
        assert!(is_workbench_browser_request(&request(owner, workspace)).is_err());
    }
    assert_eq!(
        is_workbench_browser_request(&request(&Uuid::new_v4().to_string(), "")).unwrap(),
        false
    );
}

#[test]
fn workbench_native_labels_preserve_path_identity_without_path_characters() {
    let label = browser_webview_label("workbench:/tmp/Project with spaces/é");
    assert!(label.chars().all(|c| c.is_ascii_alphanumeric() || c == '-'));
    assert!(label.len() < 100);
    assert_eq!(
        label,
        browser_webview_label("workbench:/tmp/Project with spaces/é")
    );
    assert_ne!(
        browser_webview_label("workbench:/tmp/a-b"),
        browser_webview_label("workbench:/tmp/ab")
    );
    assert_ne!(
        browser_webview_label("workbench"),
        browser_webview_label("workbench:/tmp/a-b")
    );
}

#[test]
fn restored_subagents_get_private_browsers_from_durable_ownership() {
    use gyro_core::{CreateSessionContext, GyroPaths, SessionOrigin, SessionStore};
    let temp = tempfile::tempdir().unwrap();
    let paths = GyroPaths::from_base_dir(temp.path().join("store"));
    let store = SessionStore::open(paths.clone()).unwrap();
    let parent = store
        .create_session(temp.path(), SessionOrigin::Desktop, "Parent")
        .unwrap();
    let child = store
        .create_subagent_session(
            temp.path(),
            SessionOrigin::Desktop,
            "Research",
            CreateSessionContext::default(),
            parent.id,
        )
        .unwrap();
    drop(store);
    let store = SessionStore::open(paths).unwrap();
    assert!(!session_browser_is_background_only(&store, &parent.id.to_string()).unwrap());
    assert!(session_browser_is_background_only(&store, &child.id.to_string()).unwrap());
    assert!(session_browser_is_background_only(&store, &Uuid::new_v4().to_string()).is_err());
}

#[test]
fn agent_browser_cannot_be_revealed_but_parent_browser_can() {
    let manager = SessionBrowserManager::default();
    for (id, private) in [("parent", false), ("agent", true)] {
        manager
            .inner
            .lock()
            .unwrap()
            .insert(id.into(), browser_slot(id, private));
        manager.set_visible_flag(id, true).unwrap();
        let snapshot = manager.get_snapshot(id).unwrap().unwrap();
        assert_eq!(snapshot.visible, !private);
        assert_eq!(snapshot.background_only, private);
        manager.set_visible_flag(id, false).unwrap();
        manager.set_visible_flag(id, true).unwrap();
        assert_eq!(manager.get_snapshot(id).unwrap().unwrap().visible, !private);
    }
    assert_eq!(AGENT_BROWSER_BOUNDS.width, 1280.0);
    assert_eq!(AGENT_BROWSER_BOUNDS.height, 800.0);
    assert!(AGENT_BROWSER_BOUNDS.x + AGENT_BROWSER_BOUNDS.width < 0.0);
}

#[test]
fn agent_browsers_keep_resources_page_state_and_grants_independent() {
    let manager = SessionBrowserManager::default();
    for (id, private) in [("parent", false), ("agent-a", true), ("agent-b", true)] {
        manager
            .inner
            .lock()
            .unwrap()
            .insert(id.into(), browser_slot(id, private));
    }
    manager
        .set_url("agent-a", "https://example.com/research")
        .unwrap();
    manager.set_title("agent-a", "Research").unwrap();
    manager
        .approve_origin("agent-a", "https://example.com")
        .unwrap();
    manager
        .push_console(
            &BrowserLease::from_snapshot(&manager.get_snapshot("agent-a").unwrap().unwrap()),
            BrowserConsoleEntry {
                kind: "log".into(),
                message: "ready".into(),
                source: None,
                line: None,
                column: None,
            },
        )
        .unwrap();
    manager
        .remember_pointer_capture(
            "agent-a",
            "capture-a".into(),
            "https://example.com/research".into(),
            serde_json::json!({}),
        )
        .unwrap();
    let a = manager
        .require_owned("agent-a", "shared-workspace")
        .unwrap();
    for id in ["parent", "agent-b"] {
        let other = manager.require_owned(id, "shared-workspace").unwrap();
        assert_ne!(a.resource_id, other.resource_id);
        assert_ne!(a.label, other.label);
        assert_eq!(other.url, "https://example.com/");
        assert!(other.title.is_empty());
        assert!(!manager
            .is_origin_approved(id, "https://example.com")
            .unwrap());
        assert!(manager.console_entries(id, 10).unwrap().is_empty());
        assert!(manager.pointer_reference(id, "capture-a").is_err());
    }
    assert_eq!(manager.console_entries("agent-a", 10).unwrap().len(), 1);
    assert!(manager.pointer_reference("agent-a", "capture-a").is_ok());
    assert!(manager.require_owned("agent-a", "other-workspace").is_err());
    manager.remove_slot("agent-a").unwrap();
    assert!(manager.get_snapshot("agent-a").unwrap().is_none());
    assert!(manager.get_snapshot("agent-b").unwrap().is_some());
    assert!(manager.get_snapshot("parent").unwrap().is_some());
}

#[test]
fn navigable_urls_accept_public_https_and_reject_credentials() {
    assert!(browser_url_is_navigable(
        &url::Url::parse("https://example.com/path").unwrap()
    ));
    assert!(browser_url_is_navigable(
        &url::Url::parse("http://127.0.0.1:3000").unwrap()
    ));
    assert!(!browser_url_is_navigable(
        &url::Url::parse("https://user:pass@example.com").unwrap()
    ));
    assert!(!browser_url_is_navigable(
        &url::Url::parse("file:///tmp/x").unwrap()
    ));
    assert!(!browser_url_is_loopback(
        &url::Url::parse("https://example.com").unwrap()
    ));
    assert!(browser_url_is_loopback(
        &url::Url::parse("http://localhost:5173").unwrap()
    ));
}

#[test]
fn agent_script_installs_bridge_and_tools() {
    let script = agent_initialization_script("test-nonce");
    assert!(script.contains("gyro-bridge://call"));
    assert!(script.contains("__gyroBrowserAgent"));
    assert!(script.contains("readPage"));
    assert!(script.contains("credential fields"));
    assert!(script.contains("OBSERVED_PAGE_CONTENT_UNTRUSTED"));
}

#[test]
fn reviewed_check_viewport_overrides_loopback_auto_without_changing_normal_browsers() {
    let bounds = SessionBrowserBounds {
        x: -1441.0,
        y: 0.0,
        width: 1440.0,
        height: 1080.0,
    };
    let request = resource_viewport_request(true, &bounds);
    let layout = browser_viewport::geometry(request, "http://127.0.0.1:4319", &bounds).unwrap();
    assert_eq!((layout.state.width, layout.state.height), (1440.0, 1080.0));
    assert_eq!(layout.state.display_scale, 1.0);
    assert!(layout.frame.x + layout.frame.width < 0.0);
    let ordinary = resource_viewport_request(false, &bounds);
    assert!(ordinary.width.is_none() && ordinary.height.is_none());
    let layout = browser_viewport::geometry(ordinary, "http://127.0.0.1:4319", &bounds).unwrap();
    assert_eq!((layout.state.width, layout.state.height), (1280.0, 800.0));
}

#[test]
fn browser_paging_script_is_valid_javascript() {
    let script = agent_initialization_script("test-nonce");
    let mut command = crate::providers::process::command_with_gui_path("node");
    command
        .args(["-e", "new Function(process.env.GYRO_BROWSER_TEST_SCRIPT)"])
        .env("GYRO_BROWSER_TEST_SCRIPT", script);
    let output = command
        .output()
        .expect("Node is required by the desktop frontend tests");
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
}
#[test]
fn a_check_resource_never_navigates_to_an_unreviewed_origin_or_file() {
    let origin = Some("http://127.0.0.1:4317");
    assert!(resource_navigation_allowed(
        &url::Url::parse("http://127.0.0.1:4317/todos").unwrap(),
        origin
    ));
    for denied in [
        "http://127.0.0.1:4318/",
        "http://localhost:4317/",
        "https://example.com/",
        "file:///tmp/private",
        "javascript:alert(1)",
        "http://user:pass@127.0.0.1:4317/",
    ] {
        assert!(!resource_navigation_allowed(
            &url::Url::parse(denied).unwrap(),
            origin
        ));
    }
    assert!(resource_navigation_allowed(
        &url::Url::parse("https://example.com/").unwrap(),
        None
    ));
}

#[test]
fn check_must_not_pass_when_redaction_replaces_the_observed_value() {
    use gyro_core::local_check::{self as check, browser::BrowserDriver, CheckStatus};
    // Synthetic token, not a credential. The requirement is that the page
    // displays a redacted label. A page exposing this value must not pass
    // merely because Gyro's transport redacts it after the observation.
    let token = "sk-abcdefghijklmnopqrstuvwxyz123456";
    struct Driver {
        text: String,
    }
    impl BrowserDriver for Driver {
        fn call(&mut self, method: &str, _args: Value) -> anyhow::Result<Value> {
            let value = match method {
                "status" => {
                    serde_json::json!({"url":"http://127.0.0.1:4317/","readyState":"complete"})
                }
                "find" => serde_json::json!({"results":[{"ref":"1"}],"hasMore":false}),
                "checkRead" => {
                    serde_json::json!({"ok":true,"url":"http://127.0.0.1:4317/","readyState":"complete","values":{"text":self.text}})
                }
                _ => unreachable!(),
            };
            sanitize_agent_result(method, value).map_err(anyhow::Error::msg)
        }
    }
    let plan: check::CheckPlan = serde_json::from_value(serde_json::json!({
        "id":Uuid::new_v4(),"createdAt":"2026-10-30T00:00:00Z","workspaceRevision":1,
        "draft":{"sessionId":Uuid::new_v4(),"previewUrl":"http://127.0.0.1:4317","command":"","dataChanges":"Synthetic observation only","files":["page.html"],
        "criteria":[{"id":"redacted-label","requirement":"The page displays a redacted label","scope":"browser","expected":{"text":"[REDACTED]"}}],
        "browser":{"readySelector":"body","steps":[{"action":"observe","criterionId":"redacted-label","waitMs":0,"reads":[{"key":"text","selector":"#label","kind":"text"}]}]}},
        "snapshot":{"workspace":"/tmp","gitHead":null,"files":[]}
    })).unwrap();
    for (text, expected) in [
        (token, CheckStatus::NotChecked),
        ("[REDACTED]", CheckStatus::Passed),
        ("ordinary visible text", CheckStatus::Failed),
    ] {
        let mut driver = Driver { text: text.into() };
        let output = check::browser::run(&plan, &mut driver, Default::default()).unwrap();
        let report = check::report_from_output(plan.clone(), output);
        assert_eq!(report.results[0].status, expected);
        if expected == CheckStatus::NotChecked {
            assert!(report.results[0].actual.is_none());
            assert!(report.results[0].reason.contains("privacy filtering"));
        }
        assert!(!serde_json::to_string(&report).unwrap().contains(token));
    }
}

#[test]
fn check_reads_require_unchanged_values_without_disabling_browser_redaction() {
    let token = "sk-abcdefghijklmnopqrstuvwxyz123456";
    for values in [
        serde_json::json!({"text": " padded "}),
        serde_json::json!({"text": "x".repeat(MAX_ENTRY_CHARS + 1)}),
        serde_json::json!({"texts": [token]}),
    ] {
        let error =
            sanitize_agent_result("checkRead", serde_json::json!({"values":values})).unwrap_err();
        assert!(error.contains("privacy filtering"));
        assert!(!error.contains(token));
    }
    let values = serde_json::json!({"text":"[REDACTED]","texts":["okay"],"items":0});
    let result = sanitize_agent_result(
        "checkRead",
        serde_json::json!({"values":values,"title":token}),
    )
    .unwrap();
    assert_eq!(result["values"], values);
    assert_eq!(result["title"], "[REDACTED]");
    // Ordinary browser tooling retains its existing privacy filtering.
    let ordinary = sanitize_agent_result("readPage", serde_json::json!({"tree":token})).unwrap();
    assert_eq!(ordinary["tree"], "[REDACTED]");
}
