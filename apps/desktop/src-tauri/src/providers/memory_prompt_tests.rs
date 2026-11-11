//! Exercise the production prompt paths used by every executable adapter.
//! No credentials, provider subprocesses, or paid model requests are used.
use super::{
    provider_context_message_for_turn, provider_context_message_with_capabilities,
    provider_context_message_with_capabilities_for_turn, ChatMode, PromptTurn, ProviderChatRequest,
};
use gyro_core::{project_memory::prepare_memory_context, GyroPaths, SessionOrigin, SessionStore};
use serde_json::json;

#[test]
fn project_memory_reaches_every_provider_in_fresh_and_resumed_desktop_prompts() {
    let temp = tempfile::tempdir().unwrap();
    let project = temp.path().join("project");
    std::fs::create_dir_all(project.join(".gyro")).unwrap();
    std::fs::write(
        project.join(".gyro/memory.md"),
        "- Run frontend tests with pnpm test\n",
    )
    .unwrap();
    let store = SessionStore::open(GyroPaths::from_base_dir(temp.path().join("private"))).unwrap();
    for provider in gyro_core::provider_registry()
        .iter()
        .filter(|provider| gyro_core::provider_is_executable(provider.id))
        .map(|provider| provider.id)
        .chain(["custom:memory-fixture"])
    {
        for mode in [ChatMode::Normal, ChatMode::Plan, ChatMode::Council] {
            let session = store
                .create_session(&project, SessionOrigin::Desktop, "New chat")
                .unwrap();
            let mut request: ProviderChatRequest = serde_json::from_value(json!({
                "sessionId":session.id,"providerId":provider,"modelId":"fixture-model",
                "message":"Run frontend tests","workspacePath":project,"mode":mode
            }))
            .unwrap();
            request.project_memory =
                Some(prepare_memory_context(&store, &session, &request, None).unwrap());
            // CLI adapters call context_message with fresh/resumed PromptTurn.
            for resumed in [false, true] {
                let prompt = provider_context_message_for_turn(
                    &request,
                    None,
                    PromptTurn {
                        resumed,
                        ..Default::default()
                    },
                );
                assert_eq!(
                    prompt.matches("Run frontend tests with pnpm test").count(),
                    1,
                    "{provider}/{mode:?}/{resumed}"
                );
            }
            // API and Ollama runners consume this stable/dynamic split. Memory
            // must stay in the dynamic tail even without native tool support.
            for tools in [false, true] {
                let (stable, dynamic) = crate::efficiency::capture_prompt(|| {
                    provider_context_message_with_capabilities(&request, None, tools, false)
                });
                assert!(!stable.contains("Run frontend tests with pnpm test"));
                assert_eq!(
                    dynamic.matches("Run frontend tests with pnpm test").count(),
                    1,
                    "{provider}/{tools}"
                );
                assert!(
                    dynamic.find("Project memory").unwrap()
                        < dynamic.find("User message:").unwrap()
                );
            }
            let memory = request.project_memory.as_mut().unwrap();
            memory.previous = Some(memory.render(false).1);
            let resumed = provider_context_message_with_capabilities_for_turn(
                &request,
                None,
                false,
                false,
                PromptTurn {
                    resumed: true,
                    ..Default::default()
                },
            );
            assert!(
                !resumed.contains("Run frontend tests with pnpm test"),
                "confirmed unchanged memory is not resent"
            );
            // Falling back to a fresh provider thread always sends the facts.
            assert!(
                provider_context_message_with_capabilities(&request, None, false, false)
                    .contains("Run frontend tests with pnpm test")
            );
        }
    }
}
