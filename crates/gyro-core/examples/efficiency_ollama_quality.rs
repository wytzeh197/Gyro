//! Local-only, bounded probes through Gyro's real Ollama client. Never downloads a model.
use gyro_core::{
    efficiency::context, ollama_tool_chat_with_progress, CancellationToken, OllamaToolChatRequest,
};
use serde_json::{json, Value};
use std::{
    path::PathBuf,
    time::{Duration, Instant},
};

fn main() -> anyhow::Result<()> {
    let args: Vec<_> = std::env::args().collect();
    anyhow::ensure!(
        args.len() == 4 || args.len() == 5,
        "usage: fixture.json output.json model [--live]"
    );
    let fixture: Value = serde_json::from_slice(&std::fs::read(&args[1])?)?;
    let output = PathBuf::from(&args[2]);
    let model = &args[3];
    let mut before: Vec<Value> = serde_json::from_value(fixture["before"].clone())?;
    for message in &mut before {
        message.as_object_mut().unwrap().remove("reasoning_content");
        if let Some(calls) = message["tool_calls"].as_array_mut() {
            for call in calls {
                call.as_object_mut().unwrap().remove("id");
                let parsed: Value =
                    serde_json::from_str(call["function"]["arguments"].as_str().unwrap())?;
                call["function"]["arguments"] = parsed;
            }
        }
        if message["role"] == "tool" {
            message.as_object_mut().unwrap().remove("tool_call_id");
            message["tool_name"] = json!("gyro_workspace_propose_edit");
        }
    }
    let mut after = before.clone();
    let retired = context::prepare_owned_model_request_with_policy(&mut after, false);
    anyhow::ensure!(
        retired > 0,
        "Ollama-shaped fixture did not retire arguments"
    );
    if args.get(4).map(String::as_str) != Some("--live") {
        println!("Dry run: production Ollama-shaped retirement preserved; no generation.");
        return Ok(());
    }
    anyhow::ensure!(!output.exists(), "Do not overwrite live evidence");
    let discovered = gyro_core::discover_ollama_model(None, model)?
        .ok_or_else(|| anyhow::anyhow!("The requested model is not installed"))?;
    let mut records = Vec::<Value>::new();
    for (case, prompt, expected) in [
        ("checkpoint", "The format check passed; integration tests were not run. Return JSON with exactly complete (boolean), verified (list), remaining (list). Use format and integration as the check names. Do not use tools.", json!({"complete":false,"verified":["format"],"remaining":["integration"]})),
        ("proposal-status", "According to the historical tool result, was the history.ts proposal applied or pending? Return exactly a JSON object with path and status. Do not use tools.", json!({"path":"history.ts","status":"pending"})),
    ] {
        for (arm, history) in [("before", &before), ("after", &after)] {
            let mut messages = history.clone();
            messages.push(json!({"role":"user","content":prompt}));
            let cancellation = CancellationToken::default();
            let timeout_cancel = cancellation.clone();
            let (done, received) = std::sync::mpsc::channel();
            let timer = std::thread::spawn(move || {
                if received.recv_timeout(Duration::from_secs(180)).is_err() { timeout_cancel.cancel(); }
            });
            let started = Instant::now();
            let result = ollama_tool_chat_with_progress(OllamaToolChatRequest {
                base_url: None, model, messages, tools: vec![],
                context_window_tokens: discovered.context_window_tokens, minimum_context_window_tokens: None,
            }, &cancellation, |_| {});
            let _ = done.send(());
            let _ = timer.join();
            let mut row = json!({"model":model,"case":case,"arm":arm,"elapsedMs":started.elapsed().as_millis(),"verified":false});
            match result {
                Ok(response) => {
                    let text = response.content.trim();
                    let plain = text.strip_prefix("```json\n").and_then(|s|s.strip_suffix("\n```")).unwrap_or(text);
                    row["verified"] = json!(serde_json::from_str::<Value>(plain).ok().as_ref() == Some(&expected) && response.tool_calls.is_empty());
                    row["finalText"] = json!(response.content);
                    row["usage"] = json!(response.accounted_usage);
                },
                Err(error) => row["error"] = json!(error.to_string()),
            }
            println!("{} {} verified={}", case, arm, row["verified"]);
            records.push(row);
            std::fs::write(&output, serde_json::to_vec_pretty(&json!({"scope":"local production-client probes, not full app acceptance","retiredBytes":retired,"records":records}))?)?;
        }
    }
    Ok(())
}
