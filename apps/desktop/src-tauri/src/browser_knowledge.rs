//! Shared product knowledge. Command schemas come from the actual tool registry.
use serde_json::{json, Value};

pub const GUIDE: &str = include_str!("../../../../docs/product-knowledge/browser.md");
pub const VERSION: &str = "gyro.product-knowledge.browser.v1";
pub const SIDE_PANEL_GUIDE: &str = include_str!("../../../../docs/product-knowledge/side-panel.md");
// Older provider threads may retain instructions to reveal component previews.
// Refresh just this rule on resumed turns without resending the full guide.
pub const RESUMED_REVEAL_GUIDANCE: &str = "Browser checks, interactions, and screenshots work while hidden. Keep them in the background, including component previews and dev servers. Set reveal: true only when the user explicitly asks to see the page or a required manual handoff needs it. This replaces earlier instructions to reveal visual previews.";

/// Two sentences for an ordinary turn. The side-panel guide stays off this path.
pub const ORDINARY_SURFACE_HINT: &str = "For reading or summarizing a link, prefer gyro_web_fetch; GYRO_ARTIFACTS exists for Canvas. Browser checks, interactions, and screenshots stay hidden; set reveal: true only when the user explicitly asks to see the page or a required manual handoff needs it.";

/// Browse, Canvas, a URL, or a UI preview. A bare "preview" does not qualify.
pub fn needs_surface_guide(message: &str) -> bool {
    let lower = message.to_ascii_lowercase();
    lower.contains("canvas")
        || lower.contains("gyro_artifacts")
        || lower.contains("http://")
        || lower.contains("https://")
        || lower.contains("ui preview")
        || lower.contains("component preview")
        || lower.contains("dev server")
}

pub fn contract(tools: bool, images: bool, mode: &str) -> Value {
    browser_contract(tools, images, mode, true)
}

/// The model already receives tool descriptions and schemas through its tool
/// registry (or the compatibility catalog). Keep dynamic capability facts,
/// command names, workflow examples and safety rules in the prompt once.
pub fn prompt_contract(tools: bool, images: bool, mode: &str) -> Value {
    browser_contract(tools, images, mode, false)
}

fn browser_contract(tools: bool, images: bool, mode: &str, definitions: bool) -> Value {
    let tools = tools && mode != "council";
    let commands: Vec<Value> = if tools {
        super::CAPABILITY_DESCRIPTORS
            .iter()
            .filter(|item| item.id.provider_tool_name().starts_with("gyro_browser_"))
            .map(|item| {
                if definitions {
                    json!({
                        "name": item.id.provider_tool_name(),
                        "description": item.description,
                        "inputSchema": super::desktop_capability_tool_schema(item.id),
                    })
                } else {
                    json!({ "name": item.id.provider_tool_name() })
                }
            })
            .collect()
    } else {
        Vec::new()
    };
    json!({
        "schema": VERSION,
        "capabilities": {"toolCalls": tools, "imageInput": images},
        "runMode": mode,
        "authorization": "Current broker policy; declarations do not grant permission.",
        "observationSchema": super::BROWSER_OBSERVATION_SCHEMA_V1,
        "imageEvidence": "Image bytes must be delivered; a file path is insufficient.",
        "commands": commands,
        "workflow": if tools { json!([
            {"tool": "gyro_browser_open", "arguments": {"url": "http://127.0.0.1:8766/browser-observation.html"}},
            {"tool": "gyro_browser_read_page", "arguments": {}},
            {"tool": "gyro_browser_screenshot", "arguments": {"device": "desktop"}},
            {"tool": "gyro_browser_click", "arguments": {"ref": "<reference from the latest read or find>"}},
            {"tool": "gyro_browser_read_page", "arguments": {}}
        ]) } else { json!([]) },
        "workflowNote": "Illustrative browser interaction fixture, not the default for reading links. Prefer gyro_web_fetch for text-only research; reveal the browser only when the user explicitly asks to see the page or a required manual handoff needs it. Implementation checks, interactions, and screenshots stay hidden. Use the user's URL and observed references. Plan mode permits only operations allowed by its read-only policy."
    })
}

pub fn context(tools: bool, images: bool, mode: &str, detailed: bool) -> String {
    if !detailed {
        return ORDINARY_SURFACE_HINT.to_string();
    }
    let contract = prompt_contract(tools, images, mode);
    format!("{GUIDE}\nCurrent browser capability contract:\n{contract}\n{SIDE_PANEL_GUIDE}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn both_prompt_forms_keep_visual_checks_hidden_and_reveal_for_user_requests() {
        let ordinary = context(true, true, "normal", false);
        assert!(ordinary.contains("gyro_web_fetch"));
        assert!(ordinary.contains("reveal: true"));
        assert!(ordinary.contains("only when the user explicitly asks to see the page"));
        assert!(ordinary.contains("stay hidden"));
        assert!(!ordinary.contains("while the panel stays hidden"));
        assert!(!ordinary.contains(SIDE_PANEL_GUIDE));
        assert!(!needs_surface_guide("preview the diff"));
        assert!(needs_surface_guide("open https://example.com"));
        assert!(needs_surface_guide("check the component preview and dev server"));
        let rendered = context(true, true, "normal", true);
        assert!(rendered.contains("gyro_web_fetch"));
        assert!(rendered.contains("reveal: true"));
        assert!(rendered.contains("only when the user explicitly asks to see the page"));
        assert!(rendered.contains("while the panel stays hidden"));
        assert!(rendered.contains(SIDE_PANEL_GUIDE));
        assert!(!rendered.contains("or check a web app they are building, show it"));
        assert!(!rendered.contains("reveal: true to present the preview"));
        assert!(!rendered.contains("Leave the working preview open"));
        assert!(!rendered.contains("Keep the working preview open"));
        assert!(!rendered.contains("visual previews, or user handoff"));
        let contract = contract(true, true, "normal");
        for name in ["gyro_browser_open", "gyro_browser_navigate"] {
            let command = contract["commands"]
                .as_array()
                .unwrap()
                .iter()
                .find(|command| command["name"] == name)
                .unwrap();
            let schema = &command["inputSchema"];
            assert_eq!(schema["properties"]["reveal"]["type"], "boolean");
            assert_eq!(schema["properties"]["reveal"]["default"], false);
            assert_eq!(schema["required"], json!(["url"]));
            let description = command["description"].as_str().unwrap();
            assert!(description.contains(
                "Keep implementation checks, interactions, and screenshots in the background"
            ));
            assert!(!description.contains("a visual preview, or"));
            let reveal_description = schema["properties"]["reveal"]["description"]
                .as_str()
                .unwrap();
            assert!(
                reveal_description.contains("only when the user explicitly asks to see the page")
            );
            assert!(reveal_description.contains("these work while hidden"));
        }
    }

    #[test]
    fn model_contract_keeps_capability_and_safety_facts_without_duplicate_definitions() {
        for tools in [false, true] {
            for images in [false, true] {
                for mode in ["normal", "plan", "council"] {
                    let full = contract(tools, images, mode);
                    let compact = prompt_contract(tools, images, mode);
                    for key in [
                        "schema",
                        "capabilities",
                        "runMode",
                        "authorization",
                        "observationSchema",
                        "imageEvidence",
                        "workflow",
                        "workflowNote",
                    ] {
                        assert_eq!(compact[key], full[key], "{key}: {mode}/{tools}/{images}");
                    }
                    let full_names = full["commands"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .map(|item| &item["name"])
                        .collect::<Vec<_>>();
                    let compact_names = compact["commands"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .map(|item| &item["name"])
                        .collect::<Vec<_>>();
                    assert_eq!(compact_names, full_names);
                    let rendered = context(tools, images, mode, true);
                    assert!(rendered.contains(GUIDE));
                    assert!(rendered.contains(SIDE_PANEL_GUIDE));
                    assert!(rendered.contains(&compact.to_string()));
                    assert!(!rendered.contains("\"inputSchema\""));
                }
            }
        }
        let full_bytes = contract(true, true, "normal").to_string().len();
        let compact_bytes = prompt_contract(true, true, "normal").to_string().len();
        assert!(compact_bytes * 2 < full_bytes);
        println!("Browser prompt contract fixture: {full_bytes} -> {compact_bytes} UTF-8 bytes");
    }

    #[test]
    fn browser_knowledge_contract_matches_runtime_and_examples() {
        let actual = contract(true, true, "normal");
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../docs/product-knowledge/browser.contract.json");
        if std::env::var_os("GYRO_UPDATE_KNOWLEDGE").is_some() {
            std::fs::write(&path, serde_json::to_string_pretty(&actual).unwrap() + "\n").unwrap();
        }
        let saved: Value = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
        assert_eq!(
            saved, actual,
            "Regenerate the reference contract after reviewing schema changes"
        );
        let commands = actual["commands"].as_array().unwrap();
        for step in actual["workflow"].as_array().unwrap() {
            let command = commands
                .iter()
                .find(|item| item["name"] == step["tool"])
                .unwrap();
            let args = step["arguments"].as_object().unwrap();
            let schema = &command["inputSchema"];
            for required in schema["required"].as_array().unwrap() {
                assert!(args.contains_key(required.as_str().unwrap()));
            }
            for name in args.keys() {
                assert!(schema["properties"].get(name).is_some());
            }
        }
        for tools in [false, true] {
            for images in [false, true] {
                for mode in ["normal", "plan", "council"] {
                    let value = contract(tools, images, mode);
                    let callable = tools && mode != "council";
                    assert_eq!(value["capabilities"]["toolCalls"], callable);
                    assert_eq!(value["capabilities"]["imageInput"], images);
                    assert_eq!(value["commands"].as_array().unwrap().is_empty(), !callable);
                    assert_eq!(value["workflow"].as_array().unwrap().is_empty(), !callable);
                }
            }
        }
    }
}
