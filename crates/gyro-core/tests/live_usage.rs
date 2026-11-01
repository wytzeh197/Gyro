//! A server withholds completion until the consumer receives usage. This
//! catches adapters that collect stream counts but only publish on return.
use gyro_core::{CancellationToken, UsageTokens};
use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpListener;
use std::sync::mpsc;
use std::time::Duration;

#[test]
fn request_usage_arrives_before_completion_for_api_and_ollama() {
    for ollama in [false, true] {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let (seen, wait) = mpsc::channel();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let mut reader = BufReader::new(&mut stream);
            let mut line = String::new();
            let mut length = 0;
            loop {
                line.clear();
                reader.read_line(&mut line).unwrap();
                if line == "\r\n" {
                    break;
                }
                if let Some((key, value)) = line.split_once(':') {
                    if key.eq_ignore_ascii_case("content-length") {
                        length = value.trim().parse().unwrap();
                    }
                }
            }
            reader.read_exact(&mut vec![0; length]).unwrap();
            drop(reader);
            let (first, last, content_type) = if ollama {
                (
                    "{\"message\":{\"content\":\"hello\"},\"done\":false,\"prompt_eval_count\":100,\"eval_count\":1}\n",
                    "{\"done\":true,\"prompt_eval_count\":100,\"eval_count\":2}\n",
                    "application/x-ndjson",
                )
            } else {
                (
                    "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"hello\"}}],\"usage\":{\"prompt_tokens\":100,\"completion_tokens\":1}}\n\n",
                    "data: {\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":100,\"completion_tokens\":2}}\n\ndata: [DONE]\n\n",
                    "text/event-stream",
                )
            };
            write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{first}", first.len()*2 + last.len()).unwrap();
            stream.flush().unwrap();
            assert_eq!(wait.recv_timeout(Duration::from_secs(5)).unwrap(), (100, 1));
            // Identical snapshots must not generate redundant live events.
            write!(stream, "{first}{last}").unwrap();
        });
        let mut readings = Vec::new();
        let mut on_usage = |tokens: UsageTokens| {
            if readings.is_empty() {
                seen.send((tokens.input_tokens, tokens.output_tokens))
                    .unwrap();
            }
            readings.push(tokens);
        };
        let cancel = CancellationToken::default();
        let final_tokens = if ollama {
            gyro_core::ollama::ollama_tool_chat_with_updates(
                gyro_core::OllamaToolChatRequest {
                    base_url: Some(&base),
                    model: "fixture",
                    messages: vec![],
                    tools: vec![],
                    context_window_tokens: Some(8192),
                    minimum_context_window_tokens: Some(8192),
                },
                &cancel,
                |_| {},
                |tokens, window| {
                    assert_eq!(window, Some(8192));
                    on_usage(tokens);
                },
            )
            .unwrap()
            .accounted_usage
        } else {
            gyro_core::openai_compatible::openai_compat_tool_chat_with_updates(
                gyro_core::OpenAiCompatChatRequest {
                    base_url: &base,
                    api_key: "",
                    model: "fixture",
                    messages: vec![],
                    tools: vec![],
                    allow_tool_calls: false,
                    reasoning_effort: None,
                },
                &cancel,
                |_| {},
                &mut on_usage,
            )
            .unwrap()
            .accounted_usage
        };
        server.join().unwrap();
        assert_eq!(readings.len(), 2);
        assert_eq!(readings[1].output_tokens, 2);
        assert_eq!(final_tokens.total_tokens, 102);
        assert!(final_tokens.measured);
    }
}
