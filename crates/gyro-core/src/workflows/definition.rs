use super::{parse_template, types::*, TemplatePart};
use anyhow::{ensure, Result};
use serde::Serialize;
use std::{
    collections::{BTreeMap, HashSet},
    path::Path,
};
pub(super) fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id.bytes().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-' || byte == b'_'
        })
}
pub fn parse_definition(bytes: &[u8]) -> Result<WorkflowDefinition> {
    ensure!(
        bytes.len() <= MAX_DEFINITION_BYTES,
        "workflow exceeds 256 KiB"
    );
    let definition: WorkflowDefinition = serde_json::from_slice(bytes)?;
    validate_definition(&definition)?;
    Ok(definition)
}
pub fn validate_definition(definition: &WorkflowDefinition) -> Result<()> {
    ensure!(
        definition.schema == WORKFLOW_SCHEMA,
        "unsupported workflow schema"
    );
    ensure!(
        valid_id(&definition.id)
            && !definition.name.trim().is_empty()
            && definition.name.len() <= 200
            && definition.description.len() <= 2000,
        "invalid workflow identity"
    );
    ensure!(
        definition.inputs.len() <= 20
            && definition.roles.len() <= 12
            && !definition.steps.is_empty()
            && definition.steps.len() <= 12,
        "workflow exceeds input, role or step limits"
    );
    let mut inputs = HashSet::new();
    for input in &definition.inputs {
        ensure!(
            valid_id(&input.id)
                && inputs.insert(input.id.as_str())
                && !input.label.trim().is_empty()
                && input.label.len() <= 200,
            "invalid or duplicate workflow input"
        );
        ensure!(
            if input.input_type == WorkflowInputType::Enum {
                !input.options.is_empty()
                    && input.options.len() <= 50
                    && input
                        .options
                        .iter()
                        .all(|option| !option.is_empty() && option.len() <= 200)
                    && input.options.iter().collect::<HashSet<_>>().len() == input.options.len()
            } else {
                input.options.is_empty()
            },
            "invalid enum input options"
        );
    }
    let mut roles = HashSet::new();
    for role in &definition.roles {
        ensure!(
            valid_id(role) && roles.insert(role.as_str()),
            "invalid or duplicate workflow role"
        );
    }
    let mut steps = HashSet::new();
    let mut agents = HashSet::new();
    let mut outputs = HashSet::new();
    let mut reviews = 0;
    let mut verifications = 0;
    for step in &definition.steps {
        ensure!(
            valid_id(step.id()) && steps.insert(step.id()),
            "invalid or duplicate workflow step"
        );
        ensure!(
            !step.instructions().trim().is_empty(),
            "workflow instructions are required"
        );
        for part in parse_template(step.instructions())? {
            if let TemplatePart::Input(key) = part {
                ensure!(
                    inputs.contains(key.as_str()),
                    "unknown input placeholder {key}"
                );
            }
        }
        match step {
            WorkflowStep::Agent {
                role, output, id, ..
            } => {
                ensure!(
                    roles.contains(role.as_str())
                        && valid_id(&output.name)
                        && outputs.insert(output.name.as_str()),
                    "unknown role or invalid output producer"
                );
                agents.insert(id.as_str());
            }
            WorkflowStep::Review {
                role, source_step, ..
            } => {
                ensure!(
                    roles.contains(role.as_str()) && agents.contains(source_step.as_str()),
                    "review must refer to an earlier agent step and a declared role"
                );
                reviews += 1;
            }
            WorkflowStep::Verification { command_ref, .. } => {
                ensure!(valid_id(command_ref), "invalid command reference");
                verifications += 1;
            }
        }
    }
    let required = &definition.completion.required_outputs;
    ensure!(
        required.len() <= 12
            && required.iter().collect::<HashSet<_>>().len() == required.len()
            && required.iter().all(|name| outputs.contains(name.as_str())),
        "completion refers to an unavailable output"
    );
    ensure!(
        !definition.completion.require_review_completion || reviews > 0,
        "completion requires a review step"
    );
    ensure!(
        !definition.completion.require_verification_success || verifications > 0,
        "completion requires a verification step"
    );
    ensure!(
        serde_json::to_vec(definition)?.len() <= MAX_DEFINITION_BYTES,
        "workflow exceeds 256 KiB"
    );
    Ok(())
}
pub fn definition_hash(definition: &WorkflowDefinition) -> Result<String> {
    validate_definition(definition)?;
    Ok(crate::mutations::content_hash(&serde_json::to_vec(
        definition,
    )?))
}
pub struct DefinitionWritePlan {
    pub path: String,
    pub content: String,
    pub expected_hash: Option<String>,
}
pub fn plan_definition_write(
    current: Option<&[u8]>,
    expected: Option<&str>,
    definition: &WorkflowDefinition,
) -> Result<DefinitionWritePlan> {
    validate_definition(definition)?;
    ensure!(
        current.map(crate::mutations::content_hash).as_deref() == expected,
        "Workflow changed on disk; reload before saving"
    );
    Ok(DefinitionWritePlan {
        path: format!(".gyro/workflows/{}.json", definition.id),
        content: format!("{}\n", serde_json::to_string_pretty(definition)?),
        expected_hash: expected.map(str::to_string),
    })
}
pub fn validate_inputs(
    definition: &WorkflowDefinition,
    values: &BTreeMap<String, serde_json::Value>,
) -> Result<()> {
    ensure!(
        values
            .keys()
            .all(|key| definition.inputs.iter().any(|input| &input.id == key)),
        "unknown workflow input"
    );
    ensure!(
        serde_json::to_vec(values)?.len() <= 32 * 1024,
        "workflow input values exceed 32 KiB"
    );
    for input in &definition.inputs {
        let Some(value) = values.get(&input.id) else {
            ensure!(
                !input.required,
                "required workflow input {} is missing",
                input.id
            );
            continue;
        };
        if input.input_type == WorkflowInputType::Boolean {
            ensure!(value.is_boolean(), "input {} requires a boolean", input.id);
            continue;
        }
        let text = value
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("input {} requires text", input.id))?;
        ensure!(
            text.len() <= 8192
                && !text.contains('\0')
                && (!input.required || !text.trim().is_empty()),
            "invalid workflow input value"
        );
        match input.input_type {
            WorkflowInputType::Enum => ensure!(
                input.options.iter().any(|option| option == text),
                "input is outside its enum options"
            ),
            WorkflowInputType::Url => {
                let url = url::Url::parse(text)?;
                ensure!(
                    matches!(url.scheme(), "https" | "http")
                        && url.host_str().is_some()
                        && url.username().is_empty()
                        && url.password().is_none(),
                    "workflow URL must be HTTP(S) without credentials"
                );
            }
            WorkflowInputType::Path => ensure!(
                crate::normalize_capability_relative_path(text)? == text
                    && !crate::capability_path_is_sensitive(text)
                    && !text.contains(['\\', ':']),
                "workflow path must be a non-sensitive workspace-relative path"
            ),
            _ => {}
        }
    }
    Ok(())
}
impl WorkflowBinding {
    pub fn validate(&self, definition: &WorkflowDefinition) -> Result<()> {
        ensure!(
            self.definition_id == definition.id
                && self.definition_hash == definition_hash(definition)?,
            "workflow version changed; review and explicitly update the pinned version"
        );
        validate_inputs(definition, &self.inputs)?;
        ensure!(
            self.roles.len() <= 12 && self.commands.len() <= 12,
            "too many workflow bindings"
        );
        for role in &definition.roles {
            let binding = self
                .roles
                .get(role)
                .ok_or_else(|| anyhow::anyhow!("role {role} needs a provider and model"))?;
            ensure!(
                !binding.provider_id.trim().is_empty()
                    && binding.provider_id.len() <= 100
                    && !binding.model_id.trim().is_empty()
                    && binding.model_id.len() <= 200,
                "role needs an explicit provider and model"
            );
        }
        for step in &definition.steps {
            if let WorkflowStep::Verification { command_ref, .. } = step {
                let command = self.commands.get(command_ref).ok_or_else(|| {
                    anyhow::anyhow!("command {command_ref} needs a reviewed local binding")
                })?;
                ensure!(
                    !command.program.trim().is_empty()
                        && command.program.len() <= 1024
                        && !command.program.contains('\0')
                        && command.args.len() <= 64,
                    "invalid command binding"
                );
                for arg in &command.args {
                    for part in parse_template(arg)? {
                        if let TemplatePart::Input(key) = part {
                            ensure!(
                                definition.inputs.iter().any(|input| input.id == key),
                                "unknown command input"
                            );
                        }
                    }
                }
            }
        }
        Ok(())
    }
    pub fn command_argv(&self, id: &str) -> Result<Vec<String>> {
        let command = self
            .commands
            .get(id)
            .ok_or_else(|| anyhow::anyhow!("missing command binding"))?;
        let mut result = vec![command.program.clone()];
        for arg in &command.args {
            let mut rendered = String::new();
            for part in parse_template(arg)? {
                match part {
                    TemplatePart::Literal(text) => rendered.push_str(&text),
                    TemplatePart::Input(key) => {
                        let value = self
                            .inputs
                            .get(&key)
                            .ok_or_else(|| anyhow::anyhow!("missing command input"))?;
                        if let Some(text) = value.as_str() {
                            rendered.push_str(text);
                        } else if let Some(boolean) = value.as_bool() {
                            rendered.push_str(if boolean { "true" } else { "false" });
                        } else {
                            anyhow::bail!("command input requires text or boolean");
                        }
                    }
                }
            }
            ensure!(
                rendered.len() <= 16 * 1024,
                "rendered command argument is too large"
            );
            result.push(rendered);
        }
        Ok(result)
    }
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowListing {
    pub path: String,
    pub definition: Option<WorkflowDefinition>,
    pub hash: Option<String>,
    pub diagnostic: Option<String>,
}
pub fn read_definitions(root: &Path, private: &Path) -> Result<Vec<WorkflowListing>> {
    let directory = root.join(".gyro/workflows");
    if !directory.exists() {
        return Ok(vec![]);
    }
    ensure!(
        !directory.starts_with(private),
        "private state is outside workflow scope"
    );
    // Validate every directory component before listing; file reads remain descriptor confined.
    let mut component = root.to_path_buf();
    for part in [".gyro", "workflows"] {
        component.push(part);
        let metadata = std::fs::symlink_metadata(&component)?;
        ensure!(
            metadata.is_dir() && !metadata.file_type().is_symlink(),
            "workflow directories must be real workspace folders"
        );
    }
    let mut paths = Vec::new();
    for entry in std::fs::read_dir(directory)? {
        let entry = entry?;
        let name = entry
            .file_name()
            .into_string()
            .map_err(|_| anyhow::anyhow!("invalid workflow filename"))?;
        if name.ends_with(".json") {
            ensure!(
                paths.len() < 100,
                "more than 100 workflow definitions; narrow the project"
            );
            paths.push(name);
        }
    }
    paths.sort();
    let mut listings = Vec::new();
    for name in paths {
        let path = format!(".gyro/workflows/{name}");
        let parsed = (|| -> Result<_> {
            let bytes = crate::project_memory::confined_bytes(root, &path, MAX_DEFINITION_BYTES)?
                .ok_or_else(|| anyhow::anyhow!("workflow disappeared"))?;
            let definition = parse_definition(&bytes)?;
            ensure!(
                name == format!("{}.json", definition.id),
                "workflow ID must match its filename"
            );
            let hash = definition_hash(&definition)?;
            Ok((definition, hash))
        })();
        match parsed {
            Ok((definition, hash)) => listings.push(WorkflowListing {
                path,
                definition: Some(definition),
                hash: Some(hash),
                diagnostic: None,
            }),
            Err(error) => listings.push(WorkflowListing {
                path,
                definition: None,
                hash: None,
                diagnostic: Some(error.to_string()),
            }),
        }
    }
    Ok(listings)
}
