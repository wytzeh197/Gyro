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
    let mut unique = std::collections::BTreeMap::<String, Candidate>::new();
    for c in candidates {
        let entry = unique.entry(c.path.clone()).or_insert_with(|| Candidate {
            path: c.path.clone(),
            ..Default::default()
        });
        entry.explicit |= c.explicit;
        entry.search_matches = entry.search_matches.saturating_add(c.search_matches);
        entry.symbol_matches = entry.symbol_matches.saturating_add(c.symbol_matches);
        entry.referenced |= c.referenced;
        entry.test |= c.test;
        entry.changed |= c.changed;
    }
    let mut ranked = unique.into_values().collect::<Vec<_>>();
    ranked.sort_by(|a, b| b.score().cmp(&a.score()).then(a.path.cmp(&b.path)));
    ranked.truncate(limit.min(100));
    ranked
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
