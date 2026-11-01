//! Explicit local-runtime probes. Normal test runs never make provider calls.
//! Run with GYRO_LIVE_OLLAMA_MODEL and --ignored --test-threads=1.
use gyro_core::{
    discover_ollama_model, ollama_tool_chat_with_progress, CancellationToken,
    OllamaToolChatRequest, OLLAMA_CANCELLED_MESSAGE,
};
use serde_json::{json, Value};
use std::sync::mpsc;
use std::time::{Duration, Instant};

fn selected() -> gyro_core::OllamaModel {
    let model = std::env::var("GYRO_LIVE_OLLAMA_MODEL")
        .expect("set GYRO_LIVE_OLLAMA_MODEL to an installed local model");
    discover_ollama_model(None, &model)
        .unwrap()
        .expect("model is installed")
}

fn save(name: &str, value: Value) {
    eprintln!("{value}");
    if let Ok(directory) = std::env::var("GYRO_LIVE_OLLAMA_REPORT_DIR") {
        std::fs::create_dir_all(&directory).unwrap();
        std::fs::write(
            std::path::Path::new(&directory).join(name),
            serde_json::to_vec_pretty(&value).unwrap(),
        )
        .unwrap();
    }
}

#[test]
#[ignore = "requires explicit local Ollama model and performs real generation"]
fn text_response_retains_a_prompt_larger_than_the_server_default() {
    let model = selected();
    let window = model
        .context_window_tokens
        .expect("the probe needs model context metadata");
    assert!(
        window >= 16384,
        "the long-prompt probe needs a model with at least 16k context"
    );
    let text = (0..1500)
        .map(|i| format!("fixture item {i:04}: blue green red.\n"))
        .collect::<String>();
    let messages = vec![
        json!({"role":"system", "content":"Read the provided fixture data. Reply briefly when asked. Do not call tools."}),
        json!({"role":"user", "content":format!("Fixture data:\n{text}\nReply with exactly READY.")}),
    ];
    let token = CancellationToken::default();
    let worker_token = token.clone();
    let model_id = model.id.clone();
    let (sender, receiver) = mpsc::channel();
    let started = Instant::now();
    let worker = std::thread::spawn(move || {
        sender
            .send(ollama_tool_chat_with_progress(
                OllamaToolChatRequest {
                    base_url: None,
                    model: &model_id,
                    messages,
                    tools: Vec::new(),
                    context_window_tokens: Some(window),
                    minimum_context_window_tokens: None,
                },
                &worker_token,
                |_| {},
            ))
            .unwrap();
    });
    let result = match receiver.recv_timeout(Duration::from_secs(90)) {
        Ok(result) => result,
        Err(error) => {
            token.cancel();
            let _ = receiver.recv_timeout(Duration::from_secs(2));
            panic!("local response deadline: {error}");
        }
    };
    worker.join().unwrap();
    let response = result.unwrap();
    let input = response
        .input_tokens
        .expect("runtime reports prompt tokens");
    let evidence = json!({
        "schema":"gyro.ollama-live-probe.v1", "probe":"large-text-prompt",
        "model":model.id, "modelContextTokens":window,
        "requestedContextTokens":response.context_window_tokens,
        "inputTokens":input, "outputTokens":response.output_tokens,
        "responsePresent":!response.content.trim().is_empty(),
        "toolCalls":response.tool_calls.len(), "elapsedMs":started.elapsed().as_millis(),
    });
    save("ollama-live-context.json", evidence);
    assert!(
        input > 4096,
        "the large prompt was still truncated to a small runtime window"
    );
    assert!(!response.content.trim().is_empty());
    assert!(response.tool_calls.is_empty());
}

#[test]
#[ignore = "requires explicit local Ollama model and performs real generation"]
fn stop_interrupts_a_live_generation_after_visible_output() {
    let model = selected();
    let token = CancellationToken::default();
    let worker_token = token.clone();
    let model_id = model.id.clone();
    let window = model.context_window_tokens;
    let (sender, receiver) = mpsc::channel();
    let worker = std::thread::spawn(move || {
        let mut cancelled_at = None;
        let result = ollama_tool_chat_with_progress(
            OllamaToolChatRequest {
                base_url: None,
                model: &model_id,
                messages: vec![
                    json!({"role":"user", "content":"Write a long story with at least 1000 sentences. Start the story immediately and continue until complete."}),
                ],
                tools: Vec::new(),
                context_window_tokens: window,
                minimum_context_window_tokens: None,
            },
            &worker_token,
            |text| {
                if cancelled_at.is_none() && !text.is_empty() {
                    cancelled_at = Some(Instant::now());
                    worker_token.cancel();
                }
            },
        );
        sender
            .send((result, cancelled_at.map(|at| at.elapsed())))
            .unwrap();
    });
    let (result, stop_time) = match receiver.recv_timeout(Duration::from_secs(90)) {
        Ok(result) => result,
        Err(error) => {
            token.cancel();
            let _ = receiver.recv_timeout(Duration::from_secs(2));
            panic!("local cancellation probe deadline: {error}");
        }
    };
    worker.join().unwrap();
    let stop_time = stop_time.expect("the runtime produced visible output before Stop");
    let cancelled = result
        .as_ref()
        .is_err_and(|error| error.to_string() == OLLAMA_CANCELLED_MESSAGE);
    save(
        "ollama-live-cancel.json",
        json!({
            "schema":"gyro.ollama-live-probe.v1", "probe":"cancel-after-first-text",
            "model":model.id, "visibleOutputObserved":true,
            "cancelled":cancelled, "stopMs":stop_time.as_secs_f64()*1000.,
        }),
    );
    assert!(cancelled);
    assert!(stop_time < Duration::from_secs(1));
}
