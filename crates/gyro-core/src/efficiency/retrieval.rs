use serde::{Deserialize, Serialize};
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Candidate {
    pub root_id: String,
    pub path: String,
    pub explicit: bool,
    pub search_matches: u32,
    pub symbol_matches: u32,
    pub referenced: bool,
    pub test: bool,
    pub changed: bool,
}
impl Candidate {
    pub fn score(&self) -> u64 {
        u64::from(self.explicit) * 1000
            + u64::from(self.search_matches.min(20)) * 20
            + u64::from(self.symbol_matches.min(20)) * 30
            + u64::from(self.referenced) * 100
            + u64::from(self.test) * 30
            + u64::from(self.changed) * 50
    }
}
pub fn rank(candidates: Vec<Candidate>, limit: usize) -> Vec<Candidate> {
    // Same path in two workspaces must not share a score.
    // An empty root_id is its own unbound bucket. It folds into a non-empty id
    // only when that path has exactly one such id, so the binding is
    // unambiguous. With two or more workspaces the empty signal stays unbound
    // and does not attach to whichever bucket was inserted first.
    let mut groups = std::collections::BTreeMap::<String, Vec<Candidate>>::new();
    for candidate in candidates {
        let buckets = groups.entry(candidate.path.clone()).or_default();
        if let Some(entry) = buckets
            .iter_mut()
            .find(|entry| entry.root_id == candidate.root_id)
        {
            merge_evidence(entry, &candidate);
        } else {
            buckets.push(candidate);
        }
    }
    let mut ranked = Vec::new();
    for mut buckets in groups.into_values() {
        let nonempty = buckets
            .iter()
            .filter(|entry| !entry.root_id.is_empty())
            .count();
        if nonempty == 1 {
            if let Some(index) = buckets.iter().position(|entry| entry.root_id.is_empty()) {
                let unbound = buckets.remove(index);
                if let Some(entry) = buckets.iter_mut().find(|entry| !entry.root_id.is_empty()) {
                    merge_evidence(entry, &unbound);
                }
            }
        }
        ranked.extend(buckets);
    }
    ranked.sort_by(|a, b| {
        b.score()
            .cmp(&a.score())
            .then(a.path.cmp(&b.path))
            .then(a.root_id.cmp(&b.root_id))
    });
    ranked.truncate(limit.min(100));
    ranked
}

fn merge_evidence(entry: &mut Candidate, candidate: &Candidate) {
    entry.explicit |= candidate.explicit;
    entry.search_matches = entry.search_matches.saturating_add(candidate.search_matches);
    entry.symbol_matches = entry.symbol_matches.saturating_add(candidate.symbol_matches);
    entry.referenced |= candidate.referenced;
    entry.test |= candidate.test;
    entry.changed |= candidate.changed;
}

/// Combine a saved checkpoint's `repository_signals` with the in-memory pending copy.
///
/// `save_checkpoint` assigns the pending signals onto the saved record and leaves
/// that same copy in memory. Ranking sums `search_matches` and `symbol_matches`,
/// so appending both lists doubles evidence after the first save. Each distinct
/// signal is kept `max(saved_count, pending_count)` times: the overlap counts
/// once, and an observation that exists on only one side is kept.
pub fn merge_repository_signals(saved: &[Candidate], pending: &[Candidate]) -> Vec<Candidate> {
    let mut groups: Vec<(Candidate, usize, usize)> = Vec::new();
    for (index, candidate) in saved.iter().chain(pending.iter()).enumerate() {
        let from_saved = index < saved.len();
        if let Some((_, saved_count, pending_count)) = groups
            .iter_mut()
            .find(|(sample, _, _)| same_signal(sample, candidate))
        {
            if from_saved {
                *saved_count += 1;
            } else {
                *pending_count += 1;
            }
        } else {
            groups.push((
                candidate.clone(),
                usize::from(from_saved),
                usize::from(!from_saved),
            ));
        }
    }
    let mut merged = Vec::new();
    for (sample, saved_count, pending_count) in groups {
        let copies = saved_count.max(pending_count);
        for _ in 0..copies {
            merged.push(sample.clone());
        }
    }
    merged
}

fn same_signal(left: &Candidate, right: &Candidate) -> bool {
    left.root_id == right.root_id
        && left.path == right.path
        && left.explicit == right.explicit
        && left.search_matches == right.search_matches
        && left.symbol_matches == right.symbol_matches
        && left.referenced == right.referenced
        && left.test == right.test
        && left.changed == right.changed
}

fn path_looks_like_test(path: &str) -> bool {
    path.contains("test") || path.contains("spec")
}

/// One candidate per listed path for every matching signal.
///
/// `rank` adds the scores. Keeping only the first signal dropped later search
/// hits and reference marks. Paths that are not in the listing stay with the
/// caller, which still has to decide they are inside the workspace.
pub fn outline_candidates(
    listed_paths: impl IntoIterator<Item = impl AsRef<str>>,
    signals: &[Candidate],
) -> Vec<Candidate> {
    let mut by_path = std::collections::BTreeMap::<&str, Vec<&Candidate>>::new();
    for signal in signals {
        by_path.entry(signal.path.as_str()).or_default().push(signal);
    }
    let mut seen = std::collections::BTreeSet::<String>::new();
    let mut candidates = Vec::new();
    for path in listed_paths {
        let path = path.as_ref();
        if path.is_empty() || !seen.insert(path.to_string()) {
            continue;
        }
        match by_path.get(path) {
            Some(matches) if !matches.is_empty() => {
                for signal in matches {
                    let mut candidate = (*signal).clone();
                    candidate.test |= path_looks_like_test(path);
                    candidates.push(candidate);
                }
            }
            _ => candidates.push(Candidate {
                path: path.to_string(),
                test: path_looks_like_test(path),
                ..Candidate::default()
            }),
        }
    }
    candidates
}
/// A record is reusable only against the actual workspace, buffer and disk identity.
pub fn fresh(
    file: &super::checkpoint::FileEvidence,
    root: &str,
    revision: u64,
    content_hash: Option<&str>,
    disk_hash: Option<&str>,
    dirty: bool,
) -> bool {
    file.root_id == root
        && file.revision == revision
        && file.content_hash.as_deref() == content_hash
        && file.disk_hash.as_deref() == disk_hash
        && file.dirty == dirty
        && content_hash.is_some()
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn explicit_paths_first_and_bounded() {
        let c = rank(
            vec![
                Candidate {
                    path: "b".into(),
                    changed: true,
                    ..Default::default()
                },
                Candidate {
                    path: "a".into(),
                    explicit: true,
                    ..Default::default()
                },
            ],
            1,
        );
        assert_eq!(c[0].path, "a");
    }
    #[test]
    fn repeated_signals_add_and_keep_the_workspace_id() {
        let signals = vec![
            Candidate {
                path: "src/a.rs".into(),
                root_id: "root".into(),
                search_matches: 1,
                ..Default::default()
            },
            Candidate {
                path: "src/a.rs".into(),
                referenced: true,
                ..Default::default()
            },
            Candidate {
                path: "src/b.rs".into(),
                root_id: "root".into(),
                changed: true,
                ..Default::default()
            },
            Candidate {
                path: "outside.rs".into(),
                explicit: true,
                search_matches: 20,
                ..Default::default()
            },
        ];
        let listed = outline_candidates(
            ["src/b.rs", "src/a.rs", "src/a.rs", "src/tests/a.rs"],
            &signals,
        );
        assert!(listed.iter().all(|candidate| candidate.path != "outside.rs"));
        assert_eq!(
            listed
                .iter()
                .filter(|candidate| candidate.path == "src/a.rs")
                .count(),
            2
        );
        let ranked = rank(listed, 10);
        assert_eq!(ranked[0].path, "src/a.rs");
        assert_eq!(ranked[0].root_id, "root");
        assert!(ranked[0].referenced);
        assert_eq!(ranked[0].search_matches, 1);
        assert!(ranked[0].score() > ranked[1].score());
        assert!(ranked
            .iter()
            .any(|candidate| candidate.path == "src/tests/a.rs" && candidate.test));
    }
    #[test]
    fn different_workspaces_do_not_share_a_score() {
        let ranked = rank(
            vec![
                Candidate {
                    path: "a.rs".into(),
                    root_id: "one".into(),
                    search_matches: 3,
                    ..Default::default()
                },
                Candidate {
                    path: "a.rs".into(),
                    root_id: "two".into(),
                    search_matches: 4,
                    ..Default::default()
                },
            ],
            10,
        );
        assert_eq!(ranked.len(), 2);
        assert_eq!(ranked[0].root_id, "two");
        assert_eq!(ranked[0].search_matches, 4);
        assert_eq!(ranked[1].root_id, "one");
        assert_eq!(ranked[1].search_matches, 3);
    }
    #[test]
    fn save_checkpoint_overlap_is_not_double_counted() {
        // save_checkpoint stores pending.repository_signals and leaves the same
        // rows in memory. Outline merges those two copies before rank sums.
        let saved_hit = Candidate {
            path: "src/lib.rs".into(),
            root_id: "ws".into(),
            search_matches: 1,
            ..Default::default()
        };
        let symbol_hit = Candidate {
            path: "src/lib.rs".into(),
            root_id: "ws".into(),
            symbol_matches: 1,
            referenced: true,
            ..Default::default()
        };
        let saved = vec![saved_hit.clone(), saved_hit.clone(), symbol_hit.clone()];
        let pending = saved.clone();
        let ranked = rank(merge_repository_signals(&saved, &pending), 10);
        assert_eq!(ranked.len(), 1);
        assert_eq!(ranked[0].search_matches, 2);
        assert_eq!(ranked[0].symbol_matches, 1);
        assert!(ranked[0].referenced);
        let mut pending_later = pending.clone();
        pending_later.push(saved_hit.clone());
        let ranked = rank(merge_repository_signals(&saved, &pending_later), 10);
        assert_eq!(ranked[0].search_matches, 3);
        assert_eq!(ranked[0].symbol_matches, 1);
        let saved_only = rank(merge_repository_signals(&saved, &[]), 10);
        assert_eq!(saved_only[0].search_matches, 2);
        assert_eq!(saved_only[0].symbol_matches, 1);
    }
    #[test]
    fn empty_root_id_does_not_bind_to_the_first_bucket() {
        let candidates = vec![
            Candidate {
                path: "a.rs".into(),
                search_matches: 1,
                ..Default::default()
            },
            Candidate {
                path: "a.rs".into(),
                search_matches: 4,
                ..Default::default()
            },
            Candidate {
                path: "a.rs".into(),
                root_id: "one".into(),
                search_matches: 3,
                ..Default::default()
            },
            Candidate {
                path: "a.rs".into(),
                root_id: "two".into(),
                search_matches: 4,
                ..Default::default()
            },
        ];
        let assert_unbound = |ranked: Vec<Candidate>| {
            assert_eq!(ranked.len(), 3);
            let empty = ranked.iter().find(|c| c.root_id.is_empty()).unwrap();
            assert_eq!(empty.search_matches, 5);
            assert_eq!(
                ranked
                    .iter()
                    .find(|c| c.root_id == "one")
                    .unwrap()
                    .search_matches,
                3
            );
            assert_eq!(
                ranked
                    .iter()
                    .find(|c| c.root_id == "two")
                    .unwrap()
                    .search_matches,
                4
            );
        };
        assert_unbound(rank(candidates.clone(), 10));
        let mut reversed = candidates;
        reversed.reverse();
        assert_unbound(rank(reversed, 10));
        let joined = rank(
            vec![
                Candidate {
                    path: "a.rs".into(),
                    search_matches: 2,
                    ..Default::default()
                },
                Candidate {
                    path: "a.rs".into(),
                    root_id: "only".into(),
                    search_matches: 3,
                    ..Default::default()
                },
            ],
            10,
        );
        assert_eq!(joined.len(), 1);
        assert_eq!(joined[0].root_id, "only");
        assert_eq!(joined[0].search_matches, 5);
    }
    #[test]
    fn dirty_buffer_invalidates() {
        let f = super::super::checkpoint::FileEvidence {
            availability: "revalidate".into(),
            path: "a".into(),
            root_id: "w".into(),
            content_hash: Some("a".into()),
            disk_hash: Some("a".into()),
            dirty: false,
            revision: 1,
        };
        assert!(!fresh(&f, "w", 1, Some("b"), Some("a"), true));
    }
}
