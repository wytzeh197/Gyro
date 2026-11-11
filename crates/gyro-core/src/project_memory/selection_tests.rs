use super::*;

fn context(source: &str, request: &str, budget: MemoryBudget) -> PreparedMemoryContext {
    let document = MemoryDocument::parse(source).unwrap();
    PreparedMemoryContext {
        suggest_candidates: false,
        selections: vec![select_memory(
            &document,
            MemoryQuery {
                root_id: "root-a",
                root_label: "Gyro",
                request,
                paths: &[],
                requested_ids: &[],
                budget,
            },
        )],
        previous: None,
        max_bytes: budget.max_bytes,
    }
}

#[test]
fn unrelated_or_empty_queries_cost_zero_tokens() {
    let source = "- Use pnpm to run frontend tests\n- Rust uses the shared runtime\n";
    for request in ["", "Hello", "What is the weather in Amsterdam?"] {
        let (text, receipt) = context(source, request, MemoryBudget::default()).render(false);
        assert!(text.is_empty(), "{request}: {text}");
        assert_eq!(receipt.estimated_tokens, 0);
    }
}

#[test]
fn relevance_paths_deduplication_and_budgets_are_deterministic() {
    let source = "- Use pnpm for frontend tests\n- Use pnpm for frontend tests\n- Rust compilation uses cargo\n- unrelated decision\n";
    let prepared = context(source, "Run frontend tests", MemoryBudget::default());
    let (text, receipt) = prepared.render(false);
    assert_eq!(text.matches("Use pnpm").count(), 1);
    assert!(!text.contains("cargo") && !text.contains("unrelated"));
    assert!(text.len() <= DEFAULT_CONTEXT_BYTES);
    assert_eq!(prepared.render(false).0, text);
    assert_eq!(receipt.roots[0].entries.len(), 1);
    assert_eq!(
        context(
            source,
            "Run frontend tests",
            MemoryBudget {
                max_bytes: 100,
                max_entries: 8
            }
        )
        .render(false)
        .0,
        ""
    );
    let tiny = MemoryBudget::default().bounded(Some(1000));
    assert_eq!(tiny.max_bytes, 30);
    assert!(context(source, "frontend", tiny).render(false).0.is_empty());
}

#[test]
fn verified_resumes_reuse_unchanged_context_and_invalidate_forgotten_text() {
    let source = "- Use pnpm for frontend tests\n";
    let mut prepared = context(source, "frontend tests", MemoryBudget::default());
    let (full, receipt) = prepared.render(false);
    prepared.previous = Some(receipt);
    let (delta, receipt) = prepared.render(true);
    assert!(delta.is_empty());
    assert_eq!(receipt.supplied_bytes, 0);
    assert_eq!(receipt.reused_count, 1);
    assert_eq!(
        prepared.render(false).0,
        full,
        "fresh provider must receive full text"
    );
    prepared.selections.clear();
    let (removed, receipt) = prepared.render(true);
    assert!(
        removed.contains("disregard all earlier") || removed.contains("Ignore earlier memory refs")
    );
    assert!(!removed.contains("Use pnpm"));
    assert_eq!(receipt.removed_keys.len(), 1);
    let (unknown, _) = context(source, "frontend", MemoryBudget::default()).render(true);
    assert!(
        unknown.contains("disregard all earlier"),
        "unconfirmed resumed context must reset"
    );
}

#[test]
fn superseded_invalid_and_text_changed_memories_are_excluded() {
    let source = "- Use old tests\n  <!-- gyro-memory:{\"v\":2,\"id\":\"old\"} -->\n- Use pnpm tests\n  <!-- gyro-memory:{\"v\":2,\"id\":\"new\",\"supersedes\":\"old\"} -->\n- future tests\n  <!-- gyro-memory:{\"v\":3,\"id\":\"future\"} -->\n";
    let (text, _) = context(source, "tests", MemoryBudget::default()).render(false);
    assert!(text.contains("pnpm"));
    assert!(!text.contains("old tests") && !text.contains("future tests"));
}

#[test]
fn repeated_turn_payload_is_smaller_without_changing_receipt_identity() {
    let source = (0..200)
        .map(|index| {
            format!(
                "- Frontend tests convention {index}: {}\n",
                "detail ".repeat(40)
            )
        })
        .collect::<String>();
    let mut prepared = context(&source, "frontend tests", MemoryBudget::default());
    let (first, receipt) = prepared.render(false);
    assert!(first.len() <= DEFAULT_CONTEXT_BYTES && receipt.roots[0].entries.len() <= 4);
    prepared.previous = Some(receipt.clone());
    let (second, reused) = prepared.render(true);
    assert!(second.is_empty());
    assert_eq!(reused.roots, receipt.roots);
}
