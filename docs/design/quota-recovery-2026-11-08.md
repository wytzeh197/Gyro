# Codex CLI authentication and quota recovery — 2026-11-08

The built-in OpenAI connection is a Codex CLI connection. Previously, a saved or inherited OpenAI API key caused `try_apply_stored_provider_api_key` to add a `gyro-openai` model provider using API billing, even while the UI and plan meter represented the ChatGPT sign-in. The reported quota rejection was therefore from a different billing path than the displayed weekly allowance.

The launcher now selects the built-in `openai` provider, removes API key/base URL environment overrides from that child, and skips the saved-key reader. Provider health checks use Codex login status and the same environment policy. Saved keys are preserved, and the API-key settings explain that saving a key does not change the Codex CLI connection.

Quota errors retain their structured Codex category. Generic quota refusals receive specific recovery guidance; old saved failures are normalized when displayed. The composer notes that a rejected quota can differ from reported plan windows. The notice follows the selected provider and clears on a later attempt/status. Numeric usage readings are preserved.

Verified:

- The user's corrected CLI launch reports `Logged in using ChatGPT`.
- All 16 credential tests and 12 provider-health tests pass. Credential regression checks cover saved/inherited keys, store errors, and other providers' key injection. The health fixture needing a localhost socket passed after rerunning outside the network sandbox.
- Native quota recovery test and all three Codex completion tests pass.
- UI and desktop TypeScript checks pass; quota, composer context, retry, run, and provider identity checks pass.
- Production-component browser fixture reviewed in dark and light themes: quota recovery and 99% weekly remaining are visible together without overlap. Existing components and semantic tokens are reused; recovery retains its alert semantics and existing Retry/technical-details controls.

Limits: no live model turn was sent, and the installed application was not rebuilt or replaced. Browser fixture review is not native acceptance. Keyboard behavior is unchanged and was reviewed in source; no new keyboard interaction was introduced.
