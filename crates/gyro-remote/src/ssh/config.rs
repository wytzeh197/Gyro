use std::{
    collections::BTreeSet,
    path::{Path, PathBuf},
};
/// Discover literal aliases without evaluating Match exec or ProxyCommand.
/// OpenSSH itself resolves all connection settings at connection time.
pub fn config_hosts(home: &Path) -> Vec<String> {
    let mut hosts = BTreeSet::new();
    let mut seen = BTreeSet::new();
    scan(&home.join(".ssh/config"), home, &mut hosts, &mut seen, 0);
    hosts.into_iter().take(256).collect()
}
fn tokens(line: &str) -> Vec<String> {
    let mut result = Vec::new();
    let mut token = String::new();
    let mut quoted = false;
    let mut escaped = false;
    for c in line.chars() {
        if escaped {
            token.push(c);
            escaped = false;
            continue;
        }
        if c == '\\' {
            escaped = true;
            continue;
        }
        if c == '"' {
            quoted = !quoted;
            continue;
        }
        if c == '#' && !quoted {
            break;
        }
        if !quoted && (c.is_whitespace() || c == '=') {
            if !token.is_empty() {
                result.push(std::mem::take(&mut token));
            }
        } else {
            token.push(c);
        }
    }
    if !token.is_empty() {
        result.push(token);
    }
    result
}
fn scan(
    path: &Path,
    home: &Path,
    hosts: &mut BTreeSet<String>,
    seen: &mut BTreeSet<PathBuf>,
    depth: usize,
) {
    if depth > 8 || seen.len() >= 64 || hosts.len() >= 256 {
        return;
    }
    let Ok(path) = path.canonicalize() else {
        return;
    };
    if !seen.insert(path.clone()) {
        return;
    }
    let Ok(metadata) = std::fs::metadata(&path) else {
        return;
    };
    if !metadata.is_file() || metadata.len() > 256 * 1024 {
        return;
    }
    let Ok(text) = std::fs::read_to_string(path) else {
        return;
    };
    for line in text.lines() {
        let words = tokens(line);
        let Some(keyword) = words.first() else {
            continue;
        };
        if keyword.eq_ignore_ascii_case("host") {
            for host in words.iter().skip(1) {
                if host.len() <= 255
                    && !host.is_empty()
                    && !host.starts_with('-')
                    && host
                        .chars()
                        .all(|c| c.is_ascii_alphanumeric() || "._-:[]%".contains(c))
                    && !host.contains(['*', '?', '!', '[', ']'])
                {
                    hosts.insert(host.clone());
                }
            }
        } else if keyword.eq_ignore_ascii_case("include") {
            for pattern in words.iter().skip(1) {
                let path = if let Some(rest) = pattern.strip_prefix("~/") {
                    home.join(rest)
                } else if Path::new(pattern).is_absolute() {
                    PathBuf::from(pattern)
                } else {
                    home.join(".ssh").join(pattern)
                };
                if let Ok(paths) = glob::glob(&path.to_string_lossy()) {
                    for path in paths.flatten().take(64) {
                        scan(&path, home, hosts, seen, depth + 1);
                    }
                }
            }
        }
    }
}
