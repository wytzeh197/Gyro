//! Workspace task discovery and custom task storage.

use crate::{
    assert_workspace_path, atomic_write_workspace_file, read_bounded_regular_file, workspace_root,
    CustomTaskCreateRequest, CustomTaskDeleteRequest, CustomTaskFile, CustomTaskRecord,
    TaskDefinitionResult, TestTreeItemResult,
};
use anyhow::Context;
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    fs,
    path::{Path, PathBuf},
};

pub(crate) const MAX_CUSTOM_WORKSPACE_TASKS: usize = 64;
pub(crate) const MAX_DISCOVERED_TASKS: usize = 240;
pub(crate) const MAX_CUSTOM_TASK_FILE_BYTES: usize = 128 * 1024;
pub(crate) const MAX_MANIFEST_SCAN_BYTES: usize = 512 * 1024;
pub(crate) const MAX_TARGETS_PER_MANIFEST: usize = 40;
pub(crate) const MAX_CUSTOM_TASK_LABEL_CHARS: usize = 80;
pub(crate) const MAX_CUSTOM_TASK_TOKEN_CHARS: usize = 400;
pub(crate) const MAX_CUSTOM_TASK_ARGS: usize = 48;

pub(crate) fn default_custom_task_group() -> String {
    "custom".into()
}

pub(crate) const MAX_WORKSPACE_MEMBERS: usize = 32;

/// Classifies a manifest name into a sidebar group and a primary/variant role.
///
/// Test wins over check, so `test:local-check-browser` stays a test while
/// `release:check` is a check. Only the exact front-door names are primary.
pub(crate) fn classify_task_name(name: &str) -> (&'static str, &'static str) {
    let name = name.to_ascii_lowercase();
    let group = if name == "test"
        || name.starts_with("test:")
        || name.starts_with("spec:")
        || name.contains("spec")
    {
        "test"
    } else if is_check_name(&name) {
        "check"
    } else if name.contains("build") || name.contains("compile") || name.contains("bundle") {
        "build"
    } else if name.contains("dev") || name.contains("start") || name.contains("serve") {
        "dev"
    } else {
        "custom"
    };
    let role = if is_primary_task_name(&name) {
        "primary"
    } else {
        "variant"
    };
    (group, role)
}

pub(crate) fn is_check_name(name: &str) -> bool {
    matches!(
        name,
        "check" | "lint" | "typecheck" | "format" | "fmt" | "vet" | "clippy"
    ) || name.ends_with(":check")
        || name.starts_with("lint:")
}

pub(crate) fn is_primary_task_name(name: &str) -> bool {
    matches!(
        name,
        "test"
            | "build"
            | "dev"
            | "start"
            | "serve"
            | "check"
            | "lint"
            | "typecheck"
            | "format"
            | "fmt"
            | "vet"
            | "clippy"
    )
}

pub(crate) fn task_id_slug(value: &str) -> String {
    let mut slug = String::new();
    for character in value.chars() {
        if character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.' | '/' | ':') {
            slug.push(character);
        } else if !slug.ends_with('-') {
            slug.push('-');
        }
    }
    slug.trim_matches('-').to_string()
}

pub(crate) fn suggested_task(
    id: String,
    label: String,
    command: &str,
    args: Vec<String>,
    group: &str,
    toolchain: &str,
    package_path: Option<String>,
    role: &str,
) -> TaskDefinitionResult {
    let channel = format!("task-{}", task_id_slug(&id).replace([':', '/'], "-"));
    TaskDefinitionResult {
        id,
        label,
        command: command.into(),
        args,
        group: group.into(),
        cwd: None,
        status: "idle".into(),
        output_channel_id: Some(channel),
        source: "suggested".into(),
        toolchain: toolchain.into(),
        package_path,
        role: role.into(),
    }
}

pub(crate) fn push_named_task(
    tasks: &mut Vec<TaskDefinitionResult>,
    id: String,
    command: &str,
    args: Vec<String>,
    name: &str,
    toolchain: &str,
    package_path: Option<String>,
) {
    let (group, role) = classify_task_name(name);
    let label = format!("{command} {}", args.join(" "));
    tasks.push(suggested_task(
        id,
        label,
        command,
        args,
        group,
        toolchain,
        package_path,
        role,
    ));
}

pub(crate) fn read_manifest_text(path: &Path, label: &str) -> Option<String> {
    let (bytes, _) = read_bounded_regular_file(path, MAX_MANIFEST_SCAN_BYTES, label).ok()?;
    if bytes.len() > MAX_MANIFEST_SCAN_BYTES {
        return None;
    }
    String::from_utf8(bytes).ok()
}

pub(crate) fn node_script_runner(root: &Path) -> &'static str {
    if root.join("pnpm-lock.yaml").exists() {
        "pnpm"
    } else if root.join("bun.lockb").exists() || root.join("bun.lock").exists() {
        "bun"
    } else if root.join("yarn.lock").exists() {
        "yarn"
    } else {
        "npm"
    }
}

pub(crate) fn discover_package_script_tasks(
    root: &Path,
    tasks: &mut Vec<TaskDefinitionResult>,
) -> anyhow::Result<()> {
    let package_json = root.join("package.json");
    if !package_json.exists() {
        return Ok(());
    }
    let (package, _) = read_bounded_regular_file(&package_json, 1024 * 1024, "package manifest")?;
    if package.len() > 1024 * 1024 {
        anyhow::bail!("package manifest exceeds the 1 MiB size limit");
    }
    let package = String::from_utf8(package).context("package manifest is not UTF-8")?;
    let Ok(value) = serde_json::from_str::<serde_json::Value>(&package) else {
        return Ok(());
    };
    let runner = node_script_runner(root);
    if let Some(scripts) = value.get("scripts").and_then(|value| value.as_object()) {
        for name in scripts.keys() {
            push_named_task(
                tasks,
                format!("package:{name}"),
                runner,
                vec!["run".into(), name.to_string()],
                name,
                "node",
                None,
            );
        }
    }
    Ok(())
}

pub(crate) fn discover_node_members(root: &Path, tasks: &mut Vec<TaskDefinitionResult>) {
    let Some(source) = read_manifest_text(&root.join("package.json"), "package manifest") else {
        return;
    };
    let Ok(value) = serde_json::from_str::<serde_json::Value>(&source) else {
        return;
    };
    discover_node_member_tasks(root, &value, node_script_runner(root), tasks);
}

/// One directory level of a workspace glob. `packages/*` matches child
/// directories. A pattern with `**` or more than one `*` is left unresolved.
pub(crate) fn expand_member_glob(root: &Path, pattern: &str, manifest_name: &str) -> Vec<PathBuf> {
    let pattern = pattern.trim().trim_matches(['"', '\'']);
    if pattern.is_empty() || pattern.contains("**") || pattern.matches('*').count() > 1 {
        return Vec::new();
    }
    if let Some(dir) = pattern.strip_suffix("/*") {
        if dir.contains('*') {
            return Vec::new();
        }
        let Ok(entries) = fs::read_dir(root.join(dir)) else {
            return Vec::new();
        };
        let mut found = Vec::new();
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
                continue;
            };
            if name.starts_with('.') || matches!(name, "node_modules" | "target" | "dist") {
                continue;
            }
            if path.join(manifest_name).is_file() {
                found.push(path);
            }
        }
        found.sort();
        return found;
    }
    if pattern.contains('*') {
        return Vec::new();
    }
    let path = root.join(pattern);
    if path.join(manifest_name).is_file() {
        vec![path]
    } else {
        Vec::new()
    }
}

pub(crate) fn capped_members(root: &Path, globs: &[String], manifest_name: &str) -> Vec<PathBuf> {
    let mut found = Vec::new();
    let mut seen = HashSet::new();
    for pattern in globs {
        for path in expand_member_glob(root, pattern, manifest_name) {
            if seen.insert(path.clone()) {
                found.push(path);
            }
            if found.len() >= MAX_WORKSPACE_MEMBERS {
                return found;
            }
        }
    }
    found
}

pub(crate) fn relative_member_path(root: &Path, member: &Path) -> Option<String> {
    let relative = member.strip_prefix(root).ok()?;
    let text = relative.to_string_lossy().replace('\\', "/");
    if text.is_empty() {
        None
    } else {
        Some(text)
    }
}

pub(crate) fn list_item_value(trimmed: &str) -> Option<String> {
    let rest = trimmed.trim().strip_prefix('-')?.trim();
    let value = if let Some(rest) = rest.strip_prefix('"') {
        rest.split('"').next()?.to_string()
    } else if let Some(rest) = rest.strip_prefix('\'') {
        rest.split('\'').next()?.to_string()
    } else {
        rest.split_whitespace().next()?.to_string()
    };
    if value.is_empty() {
        None
    } else {
        Some(value)
    }
}

pub(crate) fn pnpm_workspace_globs(source: &str) -> Vec<String> {
    let mut globs = Vec::new();
    let mut in_packages = false;
    for line in source.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        if !in_packages {
            if trimmed == "packages:" {
                in_packages = true;
            }
            continue;
        }
        if !trimmed.starts_with('-') {
            break;
        }
        if let Some(value) = list_item_value(trimmed) {
            globs.push(value);
        }
    }
    globs
}

pub(crate) fn package_json_workspace_globs(value: &serde_json::Value) -> Vec<String> {
    let Some(workspaces) = value.get("workspaces") else {
        return Vec::new();
    };
    let packages = if let Some(list) = workspaces.as_array() {
        list
    } else if let Some(list) = workspaces
        .get("packages")
        .and_then(|value| value.as_array())
    {
        list
    } else {
        return Vec::new();
    };
    packages
        .iter()
        .filter_map(|item| item.as_str().map(str::to_string))
        .collect()
}

pub(crate) fn node_member_globs(root: &Path, package: &serde_json::Value) -> Vec<String> {
    for name in ["pnpm-workspace.yaml", "pnpm-workspace.yml"] {
        if let Some(source) = read_manifest_text(&root.join(name), "pnpm workspace") {
            let globs = pnpm_workspace_globs(&source);
            if !globs.is_empty() {
                return globs;
            }
        }
    }
    package_json_workspace_globs(package)
}

pub(crate) fn node_member_command(
    runner: &str,
    filter: &str,
    script: &str,
) -> (String, Vec<String>) {
    match runner {
        "pnpm" => (
            "pnpm".into(),
            vec!["--filter".into(), filter.into(), script.into()],
        ),
        "yarn" => (
            "yarn".into(),
            vec!["workspace".into(), filter.into(), script.into()],
        ),
        "bun" => (
            "bun".into(),
            vec![
                "run".into(),
                "--filter".into(),
                filter.into(),
                script.into(),
            ],
        ),
        _ => (
            "npm".into(),
            vec!["run".into(), script.into(), format!("--workspace={filter}")],
        ),
    }
}

pub(crate) fn discover_node_member_tasks(
    root: &Path,
    package: &serde_json::Value,
    runner: &str,
    tasks: &mut Vec<TaskDefinitionResult>,
) {
    for member in capped_members(root, &node_member_globs(root, package), "package.json") {
        let Some(relative) = relative_member_path(root, &member) else {
            continue;
        };
        let Some(source) = read_manifest_text(&member.join("package.json"), "package manifest")
        else {
            continue;
        };
        let Ok(value) = serde_json::from_str::<serde_json::Value>(&source) else {
            continue;
        };
        let Some(scripts) = value.get("scripts").and_then(|value| value.as_object()) else {
            continue;
        };
        let filter = value
            .get("name")
            .and_then(|value| value.as_str())
            .filter(|name| !name.is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| format!("./{relative}"));
        for name in scripts.keys() {
            let (_, role) = classify_task_name(name);
            if role != "primary" {
                continue;
            }
            let (command, args) = node_member_command(runner, &filter, name);
            push_named_task(
                tasks,
                format!("package:{relative}:{name}"),
                &command,
                args,
                name,
                "node",
                Some(relative.clone()),
            );
        }
    }
}

pub(crate) fn cargo_table(line: &str) -> Option<&str> {
    let trimmed = line.trim();
    let inner = trimmed.strip_prefix('[')?.strip_suffix(']')?.trim();
    if inner.is_empty() || inner.contains('"') {
        None
    } else {
        Some(inner)
    }
}

pub(crate) fn toml_string_literal(value: &str) -> Option<String> {
    let value = value.trim().trim_end_matches(',');
    let value = value.strip_prefix('"')?.strip_suffix('"')?;
    if value.is_empty() {
        None
    } else {
        Some(value.to_string())
    }
}

pub(crate) fn cargo_is_workspace(source: &str) -> bool {
    source.lines().any(|line| {
        cargo_table(line)
            .is_some_and(|table| table == "workspace" || table.starts_with("workspace."))
    })
}

pub(crate) fn cargo_workspace_member_globs(source: &str) -> Vec<String> {
    let mut globs = Vec::new();
    let mut in_workspace = false;
    let mut in_members = false;
    for line in source.lines() {
        if let Some(table) = cargo_table(line) {
            in_workspace = table == "workspace";
            in_members = false;
            continue;
        }
        let trimmed = line.trim();
        if !in_workspace || trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        if in_members {
            if trimmed.starts_with(']') {
                in_members = false;
                continue;
            }
            if let Some(value) = toml_string_literal(trimmed) {
                globs.push(value);
            }
            continue;
        }
        let Some(rest) = trimmed.strip_prefix("members") else {
            continue;
        };
        let Some(rest) = rest.trim().strip_prefix('=') else {
            continue;
        };
        let rest = rest.trim();
        let Some(rest) = rest.strip_prefix('[') else {
            continue;
        };
        let rest = rest.trim();
        if let Some(inline) = rest.strip_suffix(']') {
            for part in inline.split(',') {
                if let Some(value) = toml_string_literal(part) {
                    globs.push(value);
                }
            }
        } else {
            in_members = true;
            if let Some(value) = toml_string_literal(rest) {
                globs.push(value);
            }
        }
    }
    globs
}

pub(crate) fn cargo_package_name(source: &str) -> Option<String> {
    let mut in_package = false;
    for line in source.lines() {
        if let Some(table) = cargo_table(line) {
            in_package = table == "package";
            continue;
        }
        if !in_package {
            continue;
        }
        let Some(rest) = line.trim().strip_prefix("name") else {
            continue;
        };
        let rest = rest.trim().strip_prefix('=')?.trim();
        return toml_string_literal(rest);
    }
    None
}

pub(crate) fn cargo_has_clippy(root: &Path, source: &str) -> bool {
    root.join("clippy.toml").is_file()
        || root.join(".clippy.toml").is_file()
        || source.contains("[lints.clippy]")
        || source.contains("[workspace.lints.clippy]")
}

pub(crate) fn cargo_has_rustfmt(root: &Path) -> bool {
    root.join("rustfmt.toml").is_file() || root.join(".rustfmt.toml").is_file()
}

pub(crate) fn push_cargo_task(
    tasks: &mut Vec<TaskDefinitionResult>,
    id: &str,
    args: Vec<String>,
    group: &str,
    package_path: Option<String>,
) {
    tasks.push(suggested_task(
        id.into(),
        format!("cargo {}", args.join(" ")),
        "cargo",
        args,
        group,
        "cargo",
        package_path,
        "primary",
    ));
}

pub(crate) fn discover_cargo_tasks(root: &Path, tasks: &mut Vec<TaskDefinitionResult>) {
    let manifest = root.join("Cargo.toml");
    if !manifest.is_file() {
        return;
    }
    let source = read_manifest_text(&manifest, "cargo manifest").unwrap_or_default();
    let workspace = cargo_is_workspace(&source);
    push_cargo_task(tasks, "cargo:build", vec!["build".into()], "build", None);
    let mut test_args = vec!["test".into()];
    let mut check_args = vec!["check".into()];
    if workspace {
        test_args.push("--workspace".into());
        check_args.push("--workspace".into());
    }
    push_cargo_task(tasks, "cargo:test", test_args, "test", None);
    push_cargo_task(tasks, "cargo:check", check_args, "check", None);
    if cargo_has_clippy(root, &source) {
        let mut args = vec!["clippy".into(), "--all-targets".into()];
        if workspace {
            args.push("--workspace".into());
        }
        push_cargo_task(tasks, "cargo:clippy", args, "check", None);
    }
    if cargo_has_rustfmt(root) {
        push_cargo_task(
            tasks,
            "cargo:fmt",
            vec!["fmt".into(), "--check".into()],
            "check",
            None,
        );
    }
}

pub(crate) fn discover_cargo_members(root: &Path, tasks: &mut Vec<TaskDefinitionResult>) {
    let Some(source) = read_manifest_text(&root.join("Cargo.toml"), "cargo manifest") else {
        return;
    };
    if !cargo_is_workspace(&source) {
        return;
    }
    for member in capped_members(root, &cargo_workspace_member_globs(&source), "Cargo.toml") {
        let Some(relative) = relative_member_path(root, &member) else {
            continue;
        };
        let Some(manifest) = read_manifest_text(&member.join("Cargo.toml"), "cargo manifest")
        else {
            continue;
        };
        let Some(name) = cargo_package_name(&manifest) else {
            continue;
        };
        push_cargo_task(
            tasks,
            &format!("cargo:{relative}:test"),
            vec!["test".into(), "-p".into(), name.clone()],
            "test",
            Some(relative.clone()),
        );
        push_cargo_task(
            tasks,
            &format!("cargo:{relative}:check"),
            vec!["check".into(), "-p".into(), name],
            "check",
            Some(relative),
        );
    }
}

/// Reads plain `target:` rules out of a Makefile, skipping pattern rules,
/// variable assignments, and recipe bodies.
pub(crate) fn makefile_targets(source: &str) -> Vec<String> {
    let mut targets = Vec::new();
    let mut seen = HashSet::new();
    for line in source.lines() {
        if line.starts_with([' ', '\t']) || line.trim_start().starts_with('#') {
            continue;
        }
        let Some(colon) = line.find(':') else {
            continue;
        };
        if line[colon..].starts_with(":=") {
            continue;
        }
        let head = line[..colon].trim();
        if head.is_empty() || head.starts_with('.') || head.contains(['%', '$', '=', '(', ')', '"'])
        {
            continue;
        }
        for target in head.split_whitespace() {
            if !target
                .chars()
                .all(|character| character.is_ascii_alphanumeric() || "-_./".contains(character))
            {
                continue;
            }
            if seen.insert(target.to_string()) {
                targets.push(target.to_string());
            }
        }
        if targets.len() >= MAX_TARGETS_PER_MANIFEST {
            break;
        }
    }
    targets.truncate(MAX_TARGETS_PER_MANIFEST);
    targets
}

pub(crate) fn discover_makefile_tasks(root: &Path, tasks: &mut Vec<TaskDefinitionResult>) {
    let Some(makefile) = ["Makefile", "makefile", "GNUmakefile"]
        .into_iter()
        .map(|name| root.join(name))
        .find(|path| path.is_file())
    else {
        return;
    };
    let Some(source) = read_manifest_text(&makefile, "makefile") else {
        return;
    };
    for target in makefile_targets(&source) {
        push_named_task(
            tasks,
            format!("make:{target}"),
            "make",
            vec![target.clone()],
            &target,
            "make",
            None,
        );
    }
}

/// Reads recipe names out of a justfile, skipping assignments and settings.
pub(crate) fn justfile_recipes(source: &str) -> Vec<String> {
    let mut recipes = Vec::new();
    let mut seen = HashSet::new();
    for line in source.lines() {
        if line.starts_with([' ', '\t']) || line.trim_start().starts_with('#') {
            continue;
        }
        let trimmed = line.trim_start_matches('@').trim();
        let Some(colon) = trimmed.find(':') else {
            continue;
        };
        if trimmed[colon..].starts_with(":=") {
            continue;
        }
        let head = trimmed[..colon].trim();
        let Some(name) = head.split_whitespace().next() else {
            continue;
        };
        if matches!(name, "set" | "export" | "alias" | "import" | "mod") {
            continue;
        }
        if !name
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || "-_".contains(character))
        {
            continue;
        }
        if seen.insert(name.to_string()) {
            recipes.push(name.to_string());
        }
        if recipes.len() >= MAX_TARGETS_PER_MANIFEST {
            break;
        }
    }
    recipes
}

pub(crate) fn discover_justfile_tasks(root: &Path, tasks: &mut Vec<TaskDefinitionResult>) {
    let Some(justfile) = ["justfile", "Justfile", ".justfile"]
        .into_iter()
        .map(|name| root.join(name))
        .find(|path| path.is_file())
    else {
        return;
    };
    let Some(source) = read_manifest_text(&justfile, "justfile") else {
        return;
    };
    for recipe in justfile_recipes(&source) {
        push_named_task(
            tasks,
            format!("just:{recipe}"),
            "just",
            vec![recipe.clone()],
            &recipe,
            "just",
            None,
        );
    }
}

pub(crate) fn discover_python_tasks(root: &Path, tasks: &mut Vec<TaskDefinitionResult>) {
    let pyproject = root.join("pyproject.toml");
    let has_project = pyproject.exists()
        || root.join("setup.py").exists()
        || root.join("pytest.ini").exists()
        || root.join("tox.ini").exists();
    if !has_project {
        return;
    }
    let uses_uv = root.join("uv.lock").is_file();
    let manifest = read_manifest_text(&pyproject, "python manifest");
    let uses_poetry = manifest
        .as_deref()
        .is_some_and(|source| source.contains("[tool.poetry"));
    let (command, prefix) = if uses_uv {
        ("uv", vec!["run".to_string()])
    } else if uses_poetry {
        ("poetry", vec!["run".to_string()])
    } else {
        ("python3", vec!["-m".to_string()])
    };
    let uses_pytest = root.join("pytest.ini").is_file()
        || root.join("tox.ini").is_file()
        || manifest
            .as_deref()
            .is_some_and(|source| source.contains("[tool.pytest") || source.contains("pytest"));
    if uses_pytest {
        let mut pytest_args = prefix.clone();
        pytest_args.push("pytest".into());
        tasks.push(suggested_task(
            "python:pytest".into(),
            format!("{command} {}", pytest_args.join(" ")),
            command,
            pytest_args,
            "test",
            "python",
            None,
            "primary",
        ));
    }
    if root.join("ruff.toml").is_file()
        || manifest
            .as_deref()
            .is_some_and(|source| source.contains("[tool.ruff"))
    {
        let mut ruff_args = prefix;
        ruff_args.push("ruff".into());
        ruff_args.push("check".into());
        tasks.push(suggested_task(
            "python:ruff".into(),
            format!("{command} {}", ruff_args.join(" ")),
            command,
            ruff_args,
            "check",
            "python",
            None,
            "primary",
        ));
    }
}

pub(crate) fn discover_go_tasks(root: &Path, tasks: &mut Vec<TaskDefinitionResult>) {
    if !root.join("go.mod").exists() {
        return;
    }
    for (name, args, group) in [
        ("build", vec!["build", "./..."], "build"),
        ("test", vec!["test", "./..."], "test"),
        ("vet", vec!["vet", "./..."], "check"),
    ] {
        tasks.push(suggested_task(
            format!("go:{name}"),
            format!("go {}", args.join(" ")),
            "go",
            args.into_iter().map(str::to_string).collect(),
            group,
            "go",
            None,
            "primary",
        ));
    }
}

pub(crate) fn discover_deno_tasks(root: &Path, tasks: &mut Vec<TaskDefinitionResult>) {
    let deno_json = root.join("deno.json");
    if !deno_json.is_file() {
        return;
    }
    let Some(source) = read_manifest_text(&deno_json, "deno manifest") else {
        return;
    };
    let Ok(value) = serde_json::from_str::<serde_json::Value>(&source) else {
        return;
    };
    let Some(entries) = value.get("tasks").and_then(|value| value.as_object()) else {
        return;
    };
    for name in entries.keys() {
        push_named_task(
            tasks,
            format!("deno:{name}"),
            "deno",
            vec!["task".into(), name.to_string()],
            name,
            "deno",
            None,
        );
    }
}

pub(crate) fn custom_tasks_path(root: &Path) -> PathBuf {
    root.join(".gyro").join("tasks.json")
}

pub(crate) fn read_custom_tasks(root: &Path) -> anyhow::Result<Vec<CustomTaskRecord>> {
    let path = custom_tasks_path(root);
    if !path.exists() {
        return Ok(Vec::new());
    }
    let (bytes, _) =
        read_bounded_regular_file(&path, MAX_CUSTOM_TASK_FILE_BYTES, "saved commands")?;
    if bytes.len() > MAX_CUSTOM_TASK_FILE_BYTES {
        anyhow::bail!("saved commands file exceeds the 128 KiB size limit");
    }
    let text = String::from_utf8(bytes).context("saved commands file is not UTF-8")?;
    let file: CustomTaskFile =
        serde_json::from_str(&text).context("saved commands file is not valid JSON")?;
    Ok(file
        .tasks
        .into_iter()
        .filter(|task| {
            !task.id.trim().is_empty()
                && !task.command.trim().is_empty()
                && task.args.len() <= MAX_CUSTOM_TASK_ARGS
        })
        .take(MAX_CUSTOM_WORKSPACE_TASKS)
        .collect())
}

pub(crate) fn write_custom_tasks(root: &Path, tasks: &[CustomTaskRecord]) -> anyhow::Result<()> {
    let path = custom_tasks_path(root);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).context("create the .gyro directory")?;
    }
    let mut body = serde_json::to_vec_pretty(&CustomTaskFile {
        version: 1,
        tasks: tasks.to_vec(),
    })?;
    body.push(b'\n');
    atomic_write_workspace_file(&path, &body)
}

pub(crate) fn custom_task_definition(record: &CustomTaskRecord) -> TaskDefinitionResult {
    TaskDefinitionResult {
        id: record.id.clone(),
        label: record.label.clone(),
        command: record.command.clone(),
        args: record.args.clone(),
        group: record.group.clone(),
        cwd: record.cwd.clone(),
        status: "idle".into(),
        output_channel_id: Some(format!(
            "task-{}",
            task_id_slug(&record.id).replace([':', '/'], "-")
        )),
        source: "custom".into(),
        toolchain: "custom".into(),
        package_path: None,
        role: "primary".into(),
    }
}

/// Splits a typed command line into a program and arguments without a shell,
/// honouring single quotes, double quotes, and backslash escapes.
pub(crate) fn parse_command_line(input: &str) -> anyhow::Result<(String, Vec<String>)> {
    let mut tokens: Vec<String> = Vec::new();
    let mut current = String::new();
    let mut open = false;
    let mut quote: Option<char> = None;
    let mut characters = input.chars();
    while let Some(character) = characters.next() {
        match quote {
            Some(active) => {
                if character == active {
                    quote = None;
                } else if character == '\\' && active == '"' {
                    let escaped = characters
                        .next()
                        .ok_or_else(|| anyhow::anyhow!("command ends with a dangling escape"))?;
                    current.push(escaped);
                } else {
                    current.push(character);
                }
            }
            None => match character {
                '\'' | '"' => {
                    quote = Some(character);
                    open = true;
                }
                '\\' => {
                    let escaped = characters
                        .next()
                        .ok_or_else(|| anyhow::anyhow!("command ends with a dangling escape"))?;
                    current.push(escaped);
                    open = true;
                }
                whitespace if whitespace.is_whitespace() => {
                    if open {
                        tokens.push(std::mem::take(&mut current));
                        open = false;
                    }
                }
                other => {
                    current.push(other);
                    open = true;
                }
            },
        }
    }
    if quote.is_some() {
        anyhow::bail!("command has an unclosed quote");
    }
    if open {
        tokens.push(current);
    }
    let mut tokens = tokens.into_iter();
    let command = tokens
        .next()
        .ok_or_else(|| anyhow::anyhow!("enter a command to run"))?;
    let args: Vec<String> = tokens.collect();
    if command.chars().count() > MAX_CUSTOM_TASK_TOKEN_CHARS
        || args
            .iter()
            .any(|arg| arg.chars().count() > MAX_CUSTOM_TASK_TOKEN_CHARS)
    {
        anyhow::bail!("command parts must stay under {MAX_CUSTOM_TASK_TOKEN_CHARS} characters");
    }
    if args.len() > MAX_CUSTOM_TASK_ARGS {
        anyhow::bail!("commands are limited to {MAX_CUSTOM_TASK_ARGS} arguments");
    }
    if command.contains('\0') || args.iter().any(|arg| arg.contains('\0')) {
        anyhow::bail!("command contains an invalid character");
    }
    Ok((command, args))
}

pub(crate) fn normalize_custom_task_group(group: Option<&str>) -> String {
    match group.map(str::trim) {
        Some("build") => "build".into(),
        Some("test") => "test".into(),
        Some("dev") => "dev".into(),
        Some("check") => "check".into(),
        _ => default_custom_task_group(),
    }
}

pub(crate) fn unique_custom_task_id(base: &str, existing: &[CustomTaskRecord]) -> String {
    let slug = {
        let slug = task_id_slug(base).replace([':', '/'], "-");
        if slug.is_empty() {
            "command".to_string()
        } else {
            slug.chars().take(48).collect::<String>()
        }
    };
    let mut candidate = format!("custom:{slug}");
    let mut suffix = 2;
    while existing.iter().any(|task| task.id == candidate) {
        candidate = format!("custom:{slug}-{suffix}");
        suffix += 1;
    }
    candidate
}

pub(crate) fn custom_task_create_impl(
    request: &CustomTaskCreateRequest,
) -> anyhow::Result<Vec<TaskDefinitionResult>> {
    let root = workspace_root(&request.workspace_path)?;
    let (command, args) = parse_command_line(&request.command_line)?;
    let mut existing = read_custom_tasks(&root)?;
    if existing.len() >= MAX_CUSTOM_WORKSPACE_TASKS {
        anyhow::bail!("this workspace already has {MAX_CUSTOM_WORKSPACE_TASKS} saved commands");
    }
    let command_line = if args.is_empty() {
        command.clone()
    } else {
        format!("{command} {}", args.join(" "))
    };
    let label = request
        .label
        .as_deref()
        .map(str::trim)
        .filter(|label| !label.is_empty())
        .unwrap_or(command_line.as_str())
        .chars()
        .take(MAX_CUSTOM_TASK_LABEL_CHARS)
        .collect::<String>();
    let cwd = match request.cwd.as_deref().map(str::trim) {
        Some(relative) if !relative.is_empty() => {
            let resolved = assert_workspace_path(&root, relative)?;
            if !resolved.is_dir() {
                anyhow::bail!("working directory does not exist in this workspace");
            }
            Some(relative.to_string())
        }
        _ => None,
    };
    let record = CustomTaskRecord {
        id: unique_custom_task_id(&label, &existing),
        label,
        command,
        args,
        group: normalize_custom_task_group(request.group.as_deref()),
        cwd,
    };
    existing.push(record);
    write_custom_tasks(&root, &existing)?;
    task_discover_impl(&request.workspace_path)
}

pub(crate) fn custom_task_delete_impl(
    request: &CustomTaskDeleteRequest,
) -> anyhow::Result<Vec<TaskDefinitionResult>> {
    let root = workspace_root(&request.workspace_path)?;
    let existing = read_custom_tasks(&root)?;
    let retained: Vec<CustomTaskRecord> = existing
        .iter()
        .filter(|task| task.id != request.task_id)
        .cloned()
        .collect();
    if retained.len() != existing.len() {
        write_custom_tasks(&root, &retained)?;
    }
    task_discover_impl(&request.workspace_path)
}

pub(crate) fn task_discover_impl(
    workspace_path: &str,
) -> anyhow::Result<Vec<TaskDefinitionResult>> {
    let root = workspace_root(workspace_path)?;
    let mut tasks: Vec<TaskDefinitionResult> = read_custom_tasks(&root)
        .unwrap_or_default()
        .iter()
        .map(custom_task_definition)
        .collect();
    discover_package_script_tasks(&root, &mut tasks)?;
    discover_cargo_tasks(&root, &mut tasks);
    discover_makefile_tasks(&root, &mut tasks);
    discover_justfile_tasks(&root, &mut tasks);
    discover_python_tasks(&root, &mut tasks);
    discover_go_tasks(&root, &mut tasks);
    discover_deno_tasks(&root, &mut tasks);
    // Members come after every root toolchain so the 240-task cap keeps the
    // repo's own front door when a workspace is large.
    discover_node_members(&root, &mut tasks);
    discover_cargo_members(&root, &mut tasks);
    let mut seen = HashSet::new();
    tasks.retain(|task| seen.insert(task.id.clone()));
    tasks.truncate(MAX_DISCOVERED_TASKS);
    Ok(tasks)
}

pub(crate) fn test_discover_impl(workspace_path: &str) -> anyhow::Result<Vec<TestTreeItemResult>> {
    let tasks = task_discover_impl(workspace_path)?;
    Ok(test_tree_from_tasks(&tasks))
}

pub(crate) fn test_tree_from_tasks(tasks: &[TaskDefinitionResult]) -> Vec<TestTreeItemResult> {
    let children = tasks
        .iter()
        .filter(|task| task.group == "test")
        .map(|task| TestTreeItemResult {
            id: task.id.clone(),
            label: task.label.clone(),
            path: None,
            status: "unknown".into(),
            children: Vec::new(),
        })
        .collect::<Vec<_>>();
    vec![TestTreeItemResult {
        id: "workspace-tests".into(),
        label: "Workspace tests".into(),
        path: None,
        status: "unknown".into(),
        children,
    }]
}

pub(crate) fn content_hash(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}
