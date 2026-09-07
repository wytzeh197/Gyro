# Product knowledge for models

Gyro supplies shared product knowledge through its provider context builder. This is application context, not a user-installed skill or a file the model must discover. Codex, Claude, ACP clients and Ollama receive the same browser guidance.

## Sources

- `browser.md`: the reusable product guide, compiled into the desktop app.
- `browser.contract.json`: generated reference for a normal turn with tools and images. Runtime contracts are generated from the same command descriptors and input schemas used by the tool broker, filtered by the current capability profile. The reference file is not an authorization grant.
- `apps/desktop/src-tauri/src/browser_knowledge.rs`: contract generation, example workflow, context rendering and drift checks.

The context builder supplies a compact overview on ordinary turns. Explicit browser requests and Browser attachments include the full guide and current contract. Ollama uses discovered tool and vision capabilities; other adapters use their configured capability declarations. Council has no callable tools. The broker remains authoritative for run mode, origin grants, ownership, cancellation and protected actions.

Add future product topics as separate guides with matching generated contracts. Avoid injecting the entire product manual into every turn. Do not copy tool schemas into prose or add provider/model-specific versions of the browser guide.

## Maintenance

After changing a browser command, review its implementation and regenerate the reference:

```sh
GYRO_UPDATE_KNOWLEDGE=1 cargo test -p gyro-desktop browser_knowledge_contract_matches_runtime_and_examples
```

Review the resulting JSON diff, then validate without the update flag:

```sh
cargo test -p gyro-desktop browser_knowledge
node scripts/check-browser-capability.mjs
```

The checks cover reference drift, workflow argument names and required fields, capability combinations, Council filtering, and delivery through the shared context builder. They complement handler, authorization and transport tests; they do not prove a provider received an image or performed an action.

## Adapter-level verification

Test protocol boundaries and capability classes, not every model name:

| Boundary | Automated evidence | Representative live smoke check |
| --- | --- | --- |
| Codex app server / MCP | Request binding, MCP schema/results, image bytes, attachment expansion | Open, read, screenshot, click, re-read; attached image |
| Claude stream JSON / MCP | Structured input and output, image bytes, positional vs stdin argument contract | Same browser loop and attached image |
| ACP | Initialize/session/prompt lifecycle, MCP registration, image content blocks, error and permission routing | One connected ACP client; repeat for a client with materially different protocol behaviour |
| Ollama HTTP | Discovered tools/vision combinations, tool-result loop, image encoding, read-only fallback | Representatives of each supported capability class |

A new model using an unchanged adapter and capability class inherits these checks. Run another live check when a CLI/protocol changes, a model introduces a new capability class, a regression is reported, or a release materially changes browser behaviour. Do not require a manual run for every catalog entry.

Keep capability declarations separate from verification status. A guide teaches the workflow; it cannot repair dropped image bytes, absent tools, authentication failures, or malformed protocol messages. Existing unresolved adapter issues remain tracked in `docs/model-browser-plan.md`.
