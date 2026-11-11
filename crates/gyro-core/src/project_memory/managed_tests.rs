use super::*;
use crate::mutations::content_hash;
use serde_json::json;

fn managed(id: &str, text: &str, extra: serde_json::Value) -> String {
    let mut metadata = json!({"v":2,"id":id,"kind":"decision"});
    for (key, value) in extra.as_object().unwrap() {
        metadata[key] = value.clone();
    }
    format!("- 2026-11-10 — {text}\n  <!-- gyro-memory:{metadata} -->\n")
}

#[test]
fn managed_round_trip_and_targeted_edit_keep_all_other_bytes() {
    let source = format!(
        "# Memory  \r\n{}\r\n<!-- unknown -->\r\nprose  ",
        managed("mem_one", "Use shared runtime", json!({})).replace('\n', "\r\n")
    );
    let document = MemoryDocument::parse(&source).unwrap();
    assert_eq!(document.source(), source);
    assert!(document.diagnostics.is_empty());
    assert_eq!(document.entries[0].id, "mem_one");
    let draft = MemoryDraft {
        text: "Use portable shared runtime".into(),
        kind: MemoryKind::Convention,
        paths: vec!["crates/gyro-core".into()],
        sources: vec![MemorySource::UserEntered],
        supersedes: None,
    };
    let plan = plan_write(
        Some(&source),
        Some(&document.document_hash),
        MemoryWrite::Edit {
            id: "mem_one",
            date: "2026-11-10",
            draft: &draft,
        },
    )
    .unwrap();
    let changed = MemoryDocument::parse(&plan.content).unwrap();
    assert_eq!(changed.entries[0].id, "mem_one");
    assert!(!changed.entries[0].source_changed);
    assert_eq!(
        &plan.content[..changed.entries[0].source_span.start],
        "# Memory  \r\n"
    );
    assert!(plan.content.ends_with("\r\n<!-- unknown -->\r\nprose  "));
    let forgotten = plan_write(
        Some(&plan.content),
        Some(&changed.document_hash),
        MemoryWrite::ForgetId { id: "mem_one" },
    )
    .unwrap();
    assert_eq!(
        forgotten.content,
        "# Memory  \r\n\r\n<!-- unknown -->\r\nprose  "
    );
}

#[test]
fn malformed_newer_duplicate_and_cyclic_metadata_is_visible_but_unusable() {
    for source in [
        managed("same", "first", json!({})) + &managed("same", "second", json!({})),
        managed("a", "first", json!({"supersedes":"b"}))
            + &managed("b", "second", json!({"supersedes":"a"})),
        managed("future", "future", json!({"v":3})),
        "- entry\n  <!-- gyro-memory:{bad} -->\n".into(),
        managed(
            "private",
            "bad source",
            json!({"sources":[{"kind":"local-turn","sessionId":"secret"}]}),
        ),
        managed("path", "bad path", json!({"paths":["../other"]})),
    ] {
        let document = MemoryDocument::parse(&source).unwrap();
        assert_eq!(document.source(), source);
        assert!(!document.diagnostics.is_empty(), "{source}");
        assert!(document
            .entries
            .iter()
            .all(|entry| entry.status == MemoryStatus::Invalid));
        assert!(plan_write(
            Some(&source),
            Some(&document.document_hash),
            MemoryWrite::ForgetId {
                id: &document.entries[0].id
            }
        )
        .is_err());
    }
    let orphan = MemoryDocument::parse("<!-- gyro-memory:{} -->\n").unwrap();
    assert_eq!(orphan.diagnostics.len(), 1);
}

#[test]
fn supersession_and_external_text_change_do_not_reactivate_old_decisions() {
    let source = managed("old", "Use old runtime", json!({}))
        + &managed(
            "new",
            "Use shared runtime",
            json!({"supersedes":"old","textHash":content_hash(b"Use shared runtime")}),
        );
    let document = MemoryDocument::parse(&source).unwrap();
    assert_eq!(document.entries[0].status, MemoryStatus::Superseded);
    let altered = source.replace("Use shared runtime", "Use changed runtime");
    let document = MemoryDocument::parse(&altered).unwrap();
    assert_eq!(document.entries[0].status, MemoryStatus::Superseded);
    assert!(document.entries[1].source_changed);
}

#[test]
fn metadata_rejects_private_paths_bad_sources_and_excess_size() {
    for extra in [
        json!({"sources":[{"kind":"project-file","path":"/private/file","contentHash":"0".repeat(64)}]}),
        json!({"sources":[{"kind":"project-file","path":".env","contentHash":"0".repeat(64)}]}),
        json!({"sources":[{"kind":"commit","oid":"short"}]}),
        json!({"sources":[{"kind":"project-file","path":"src.rs","contentHash":"0".repeat(64),"lines":[2,1]}]}),
        json!({"paths":vec!["src";17]}),
        json!({"id":"x".repeat(5000)}),
    ] {
        let source = managed("bad", "entry", extra);
        assert_eq!(
            MemoryDocument::parse(&source).unwrap().entries[0].status,
            MemoryStatus::Invalid
        );
    }
}
