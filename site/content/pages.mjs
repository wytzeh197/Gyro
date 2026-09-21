import { readFileSync } from "node:fs";
import { providers } from "./providers.mjs";
import {
  esc,
  link,
  section as s,
  code,
  next,
  workflow,
  providerRows,
  download,
  releaseEntries,
  interfaceFilm,
  latest,
  snapshot,
} from "../templates/components.mjs";
const p = (text) => `<p>${text}</p>`;
const list = (items) =>
  `<ul>${items.map((i) => `<li>${i}</li>`).join("")}</ul>`;
const steps = (items) =>
  `<ol class="steps">${items.map((i) => `<li>${i}</li>`).join("")}</ol>`;
const intro = (title, desc) =>
  `<header class="page-intro"><h1>${title}</h1><p>${desc}</p></header>`;
const action = `<div class="actions">${link("/install/", "Download for macOS", "button primary")}${link("/product/", "Explore the workflow")}</div>`;
const installSteps = steps([
  "Download the matching DMG. Open it and drag <strong>Gyro.app</strong> into Applications.",
  "Try opening Gyro from Applications. This alpha is not Apple Developer ID signed or notarized; dismiss the first-launch warning.",
  "Open <strong>System Settings → Privacy &amp; Security</strong>. Under Security, choose <strong>Open Anyway</strong> beside Gyro, authenticate if asked, then confirm Open.",
  "Connect a provider, then use a safe sample project for your first session.",
]);
const featureLinks = `<div class="feature-links">${[
  [
    "chat",
    "Give the work direction.",
    "Describe the result, follow the activity, and ask a focused follow-up.",
  ],
  [
    "terminal",
    "Put the result to the test.",
    "Run local commands and read their output in the workspace.",
  ],
  [
    "review",
    "Make the final call.",
    "Inspect changed files and the diff before you commit.",
  ],
]
  .map(
    ([path, title, body]) =>
      `<article><h3>${title}</h3><p>${body}</p>${link("/product/" + path + "/", `Explore ${path}`)}</article>`,
  )
  .join("")}</div>`;
const gettingStarted =
  intro(
    "Your first useful session.",
    "Make one small change in a disposable project. Run it, inspect it, and learn the workflow before using a real codebase.",
  ) +
  s(
    "before",
    "Before you begin",
    p(
      "Install Gyro on macOS 14+, connect one supported coding provider, and install Node.js 22+ and Git for this example. Provider charges and permissions still apply. An Ollama model without tool support can discuss the example but cannot make the edit.",
    ) + link("/docs/providers/", "Connect a provider"),
  ) +
  s(
    "sample",
    "1. Create a safe project",
    p(
      "In Terminal, create a new temporary directory. These commands operate only inside that new directory:",
    ) +
      code(
        'DEMO_DIR=$(mktemp -d /tmp/gyro-first-session.XXXXXX)\ncd "$DEMO_DIR"\ngit init\nprintf \'console.log("Hello from Gyro");\\n\' > hello.mjs\ngit add hello.mjs\ngit -c user.name="Gyro Demo" -c user.email="demo@example.invalid" commit -m "Start demo"\nopen .',
      ) +
      p(
        "Success: Finder opens the temporary folder, containing hello.mjs. You have a baseline commit to compare against.",
      ),
  ) +
  s(
    "open",
    "2. Open the project",
    p(
      "Open that folder as a project in Gyro. Start a new chat and choose your connected provider from the model picker. Check the project name before sending a request.",
    ),
  ) +
  s(
    "task",
    "3. Ask for one change",
    code(
      'In hello.mjs, change the greeting to "Hello, builder!".\nDo not change other files. Explain your change.',
    ) +
      p(
        "Review any requested permissions. Success: the agent explains a one-line edit to hello.mjs. If it cannot edit files, check that your selected provider/model supports tools.",
      ),
  ) +
  s(
    "verify",
    "4. Run it and review",
    p(
      "Open Terminal in Gyro, confirm you are in the sample project, and run:",
    ) +
      code("node hello.mjs\ngit diff -- hello.mjs") +
      p(
        "Expected output: <strong>Hello, builder!</strong> The diff should show only the greeting change. Open Review to inspect the same file. A correct-looking answer alone is not proof the file changed.",
      ),
  ) +
  s(
    "finish",
    "5. Finish deliberately",
    p(
      "Keep or discard the sample edit after reading it. This is a disposable folder, so no production code is involved. Use similarly bounded tasks when you move to your own project.",
    ),
  ) +
  next(
    "/docs/troubleshooting/",
    "Resolve a setup problem",
    "If a step does not match the expected result, stop there and check the relevant recovery path.",
  );
const providerSetup =
  intro(
    "Connect your tools.",
    "Choose the provider you already use, then verify the connection before giving it a task.",
  ) +
  s(
    "cli",
    "CLI accounts",
    p(
      "Install your chosen CLI from its maintained instructions below. Open it once outside Gyro and complete the provider’s authentication flow. A successful CLI prompt is the first check; a subscription alone does not prove access. Then open Settings → Providers in Gyro, check readiness, and choose a model in a new chat.",
    ),
  ) +
  providers
    .filter((x) => x.kind === "CLI account")
    .map((x) =>
      s(
        x.id,
        x.name,
        p(x.requires) +
          (x.command ? code(x.command) : "") +
          p(x.limits) +
          link(x.url, "Provider setup reference"),
      ),
    )
    .join("") +
  s(
    "ollama",
    "Ollama",
    p(
      "Start Ollama and download a model. Refresh models in Settings → Providers, then select it in chat. No API key is needed for the local Ollama runtime.",
    ) + link("/docs/local-models/", "Local model walkthrough"),
  ) +
  s(
    "api-keys",
    "API-key presets",
    p(
      "DeepSeek, Mistral, and OpenRouter are experimental desktop integrations. In <strong>Settings → Providers → Connect with an API key</strong>, choose the preset, paste your key, and select <strong>Save key</strong>. Keys are stored through macOS Keychain. A configured provider environment variable takes priority over a stored key.",
    ),
  ) +
  providers
    .filter((x) => x.kind === "API key")
    .map((x) =>
      s(
        x.id,
        x.name,
        p("Preset endpoint: <code>" + x.endpoint + "</code>.") + p(x.limits),
      ),
    )
    .join("") +
  s(
    "custom",
    "Custom OpenAI-compatible endpoints",
    p(
      "In <strong>Settings → Providers → Add custom provider</strong>, enter a name, the exact base URL including any /v1 prefix, a key where required, and model IDs. <strong>Fetch models</strong> can populate model IDs from the endpoint.",
    ) +
      p(
        "Remote endpoints require HTTPS. A server on a loopback address may use HTTP without a key. Redirects are refused. The standalone CLI can configure these integrations, but use the desktop app for chat.",
      ) +
      p(
        "Start with a text-only request. Attachment support varies by provider and model; do not assume compatibility from the API format alone.",
      ),
  ) +
  s(
    "verify",
    "Verify the connection",
    p(
      "Select the provider/model in a new chat and ask a small question. A streamed answer confirms this request worked. A readiness check does not prove every model, tool, or billing entitlement is available.",
    ) +
      p(
        "If a key is rejected, check the provider account. If the endpoint cannot be reached, check the base URL and network. If no models appear, check the API prefix and configured model IDs.",
      ),
  ) +
  next(
    "/docs/getting-started/",
    "Start your first session",
    "Your provider is connected. Now try a small, inspectable change.",
  );
export const pages = [
  {
    path: "/",
    title: "Gyro — Your AI coding tools. One workspace.",
    description:
      "Chat with an agent, run local commands, and review changes in one open-source macOS workspace.",
    layout: "home",
    body: () =>
      `<header class="home-intro"><p class="alpha-label"><span class="status-dot"></span> Public alpha for macOS</p><h1>Your AI coding tools.<br>One workspace.</h1><div class="hero-bottom"><p>Chat, terminal, and code review. Together on your Mac.</p>${action}</div></header>
      <figure class="product-stage home-app-stage"><div class="film-frame"><img class="film-poster film-light" src="/assets/screenshots/hero-light-1200.webp" srcset="/assets/screenshots/hero-light-1200.webp 1200w, /assets/screenshots/hero-light-2400.webp 2400w" sizes="(max-width: 760px) 165vw, 1200px" width="1200" height="750" fetchpriority="high" alt="Gyro workspace: projects on the left, an agent conversation in the center, and review, terminal, browser, and file tools alongside."><img class="film-poster film-dark" src="/assets/screenshots/hero-1200.webp" srcset="/assets/screenshots/hero-1200.webp 1200w, /assets/screenshots/hero-2400.webp 2400w" sizes="(max-width: 760px) 165vw, 1200px" width="1200" height="750" alt="Gyro workspace in dark mode with projects, an agent conversation, and workspace tools."><video class="workflow-film" muted playsinline loop preload="none" aria-label="Silent example of the Gyro interface"></video></div><figcaption><span>Gyro for macOS 14+. Free and open source.</span><button type="button" class="motion-toggle" hidden>Play demo</button></figcaption></figure>
      <section id="product" class="home-workflow" aria-label="One task through Gyro"><div class="visual-heading"><h2>Ask. Run. Review.</h2>${link("/product/", "See the workflow")}</div>${workflow(null, true)}</section>
      <section class="home-tools" id="agents"><div class="visual-heading"><h2>Your tools, already at home.</h2>${link("/providers/", "All providers & setup")}</div><div class="provider-roster">${providers
        .slice(0, 6)
        .map(
          (x) =>
            `<a href="/docs/providers/#${x.id}"><img src="/assets/providers/${x.id}.svg" width="30" height="30" alt="">${x.name}</a>`,
        )
        .join(
          "",
        )}</div><p class="muted">CLI accounts, API keys, or local models. Provider charges may apply.</p></section>
      <section class="home-bottom" id="ownership"><div><h2 id="ownership-title">Your Mac. Your work.</h2><p>Sessions stay local. Cloud providers receive your request context.</p>${link("/privacy/", "Privacy & data flow")}</div><div><h2>${esc(latest.tag_name.replace("v0.1.0-", "Alpha ").replace("alpha.", ""))}</h2><p>Built in the open. See what changed.</p>${link("/changelog/", "Latest release")}</div></section>
      <section class="closing" id="download"><h2>Start with one small task.</h2>${action}<p class="home-alpha-note" id="faq-title">Public alpha. Not for production. ${link("/install/#first-launch", "Read the installation notes")}.</p><span id="faq" class="anchor-alias"></span></section>`,
  },
  {
    path: "/product/",
    title: "The Gyro workflow",
    description:
      "Follow one bounded task from an agent conversation to a local test and a reviewed diff.",
    body: () =>
      intro(
        "One task. The whole picture.",
        "Direct an agent, check its work locally, and inspect the result without losing the thread.",
      ) +
      workflow() +
      featureLinks +
      interfaceFilm() +
      s(
        "boundaries",
        "Keep your judgment in the loop",
        p(
          "Gyro brings the working surfaces together. You still choose the task, review permissions, evaluate test coverage, and decide what belongs in your project. Provider behavior and supported tools vary.",
        ),
      ) +
      next(
        "/docs/getting-started/",
        "Try your first session",
        "Use a disposable project to learn the workflow.",
      ),
  },
  {
    path: "/product/chat/",
    title: "Agent chat in Gyro",
    description:
      "Give a coding agent a bounded task, follow its activity, and continue with focused feedback.",
    body: () =>
      intro(
        "Give the work direction.",
        "Start with the result you want. Keep the scope small enough to inspect.",
      ) +
      workflow("chat") +
      s(
        "context",
        "Make the request specific",
        p(
          "Name the relevant file, describe the problem, and explain what should stay unchanged. In the retry example, the goal is five attempts with backoff and tests for recovery and failure.",
        ),
      ) +
      s(
        "activity",
        "Read what happened",
        p(
          "Gyro displays provider activity and responses in the conversation. Use file and command activity to follow the work, then inspect the actual result. Activity detail depends on what the provider reports.",
        ),
      ) +
      s(
        "follow-up",
        "Continue with evidence",
        p(
          "If a test fails, use its output in a focused follow-up. If the edit is too broad, ask for a smaller change. Review provider permissions before granting access; a chat response is not a guarantee of correctness.",
        ),
      ) +
      next(
        "/product/terminal/",
        "Check the change locally",
        "The next step is evidence from your own project.",
      ),
  },
  {
    path: "/product/terminal/",
    title: "Local terminal work in Gyro",
    description:
      "Run commands against your local project and inspect their output alongside coding-agent work.",
    body: () =>
      intro(
        "Put the result to the test.",
        "Run the commands that make a change verifiable, in the project where the work happened.",
      ) +
      workflow("terminal") +
      s(
        "local",
        "Commands run on your Mac",
        p(
          "The desktop terminal gives local shell and CLI work a place in the workspace. Check the working directory before running a command. Your installed tools, environment, and filesystem determine what it can do.",
        ),
      ) +
      s(
        "checks",
        "Choose a useful check",
        p(
          "For the retry example, two tests cover recovery after one failure and stopping after five failures. Passing those tests says nothing about unrelated code or production behavior. Use the checks appropriate to your project.",
        ),
      ) +
      s(
        "cli",
        "The desktop terminal and the Gyro CLI",
        p(
          "You can run shells and installed tools inside the desktop workspace. The separately distributed <code>gyro</code> CLI has its own commands and provider limitations; installing it with Homebrew does not install Gyro.app.",
        ) +
          link(
            "https://github.com/wytzeh197/Gyro/blob/v0.1.0-alpha.49/docs/homebrew.md",
            "CLI installation reference",
          ),
      ) +
      next(
        "/product/review/",
        "Inspect the diff",
        "Use command output and the changed files together.",
      ),
  },
  {
    path: "/product/review/",
    title: "Review changes in Gyro",
    description:
      "Inspect changed files and code diffs before deciding what to keep.",
    body: () =>
      intro(
        "Make the final call.",
        "An agent can finish a task. You decide whether the change is right.",
      ) +
      workflow("review") +
      s(
        "files",
        "Start with the files",
        p(
          "Open Review to inspect the changed-file list and diff. Check that the affected files match the request, and look for unrelated edits. A summary can help you navigate; the diff is the evidence.",
        ),
      ) +
      s(
        "meaning",
        "Read the behavior, not just the lines",
        p(
          "Here, the retry limit matters as much as the delay: the fifth failure must throw, with no sixth attempt. Check how errors are handled and whether the tests exercise that boundary.",
        ),
      ) +
      s(
        "responsibility",
        "Review before committing",
        p(
          "Do not infer approval or correctness from a completed agent turn. Inspect the work, run suitable checks, and use your project’s normal version-control process. Keep backups and avoid production work in the alpha.",
        ),
      ) +
      next(
        "/docs/getting-started/",
        "Try a small change",
        "Practice in a disposable project before using a real codebase.",
      ),
  },
  {
    path: "/providers/",
    title: "Choose a provider for Gyro",
    description:
      "Compare supported CLI accounts, local Ollama models, and experimental API-key integrations for Gyro.",
    body: () =>
      intro(
        "Your tools. Your choice.",
        "Bring a supported coding-agent account, connect an API key, or run a model on your Mac.",
      ) +
      s(
        "costs",
        "What you pay for",
        p(
          "Gyro’s current alpha is free under Apache License 2.0. There is no Gyro account gate or paid hosted model plan. CLI accounts and API keys have provider-specific access and billing. Local models use your own hardware.",
        ) +
          p(
            "Support status below is checked against Alpha 49. “Supported” does not mean every model or account has identical capabilities.",
          ),
      ) +
      providerRows() +
      next(
        "/docs/providers/",
        "Connect your chosen provider",
        "Setup instructions explain how to verify a first request.",
      ),
  },
  {
    path: "/install/",
    title: "Download Gyro for macOS",
    description:
      "Choose Apple Silicon or Intel, verify your download, and safely open the Gyro public alpha on macOS 14 or newer.",
    body: () =>
      intro(
        "A workspace for your Mac.",
        "Download Gyro for macOS 14 or newer. Free, open source, and currently in public alpha.",
      ) +
      `<div class="install-layout"><div><section class="notice"><h2>Before you install</h2><p>This alpha is not recommended for production. App downloads are not Apple Developer ID signed or notarized. Follow the first-launch steps below and keep Gatekeeper enabled.</p></section><h2>Choose your processor</h2><p>Open Apple menu → About This Mac. An Apple M-series <strong>Chip</strong> needs Apple Silicon; an Intel <strong>Processor</strong> needs Intel. Windows and Linux app builds are not offered.</p></div><section id="download" aria-label="Downloads">${download()}</section></div>` +
      s(
        "first-launch",
        "Install and open Gyro",
        installSteps +
          p(
            "Open Anyway is available for about an hour after a blocked launch. If macOS reports damage or corruption, stop and report the filename and release. Do not disable Gatekeeper or remove quarantine globally. Managed Macs may require administrator approval.",
          ),
      ) +
      s(
        "updates",
        "Updates and rollback",
        p(
          "Gyro updater signatures verify project updates; they are separate from Apple notarization. To roll back, quit Gyro, back up <code>~/Library/Application Support/Gyro/</code>, and install the older release’s matching DMG. Read its compatibility notes first.",
        ),
      ) +
      s(
        "uninstall",
        "Uninstall Gyro",
        p(
          "Quit the app and move Gyro.app to Trash. Sessions and settings remain in <code>~/Library/Application Support/Gyro/</code>. Back up that folder before deleting it if you might want the data later.",
        ),
      ) +
      s(
        "cli",
        "Need the separate CLI?",
        p(
          "Homebrew installs the gyro command, not the desktop app. Follow the maintained CLI instructions for setup and supported commands.",
        ) +
          link(
            "https://github.com/wytzeh197/Gyro/blob/v0.1.0-alpha.49/docs/homebrew.md",
            "Install the CLI",
          ) +
          " · " +
          link(
            "https://github.com/wytzeh197/Gyro#build-from-source",
            "Build from source",
          ),
      ) +
      next(
        "/docs/getting-started/",
        "Complete your first session",
        "After installation, connect a provider and make one small change.",
      ),
  },
  {
    path: "/docs/",
    title: "Gyro documentation",
    description:
      "Install Gyro, connect a provider, complete a first session, and resolve common setup problems.",
    body: () =>
      intro(
        "A useful first session starts here.",
        "Short guides for setting up your workspace and checking your first change.",
      ) +
      `<div class="guide-index">${[
        [
          "getting-started",
          "Make your first change",
          "A safe sample project, one request, a local check, and a diff.",
        ],
        [
          "providers",
          "Connect a provider",
          "CLI accounts, API keys, model selection, and connection checks.",
        ],
        [
          "local-models",
          "Run a local model",
          "Set up Ollama and understand tool and hardware limitations.",
        ],
        [
          "troubleshooting",
          "Get unstuck",
          "Installation warnings, missing providers, failed requests, and support.",
        ],
      ]
        .map(
          ([path, title, body]) =>
            `<article><h2>${link("/docs/" + path + "/", title)}</h2><p>${body}</p></article>`,
        )
        .join("")}</div>` +
      next(
        "/install/",
        "Install Gyro",
        "Need the app first? Choose the correct Mac build.",
      ),
  },
  {
    path: "/docs/getting-started/",
    title: "Get started with Gyro",
    description:
      "Make one small, testable change in a safe sample project with Gyro.",
    layout: "docs",
    body: () => gettingStarted,
  },
  {
    path: "/docs/providers/",
    title: "Set up Gyro providers",
    description:
      "Configure CLI authentication, API-key presets, custom endpoints, and a first provider request.",
    layout: "docs",
    body: () => providerSetup,
  },
  {
    path: "/docs/local-models/",
    title: "Use Ollama with Gyro",
    description:
      "Install Ollama, download a model, refresh it in Gyro, and understand local model limitations.",
    layout: "docs",
    body: () =>
      intro(
        "Run a model on your Mac.",
        "Ollama provides local model inference. Gyro supplies the workspace around it.",
      ) +
      s(
        "install",
        "1. Start Ollama",
        p(
          "Install and open Ollama. If you use the command-line installation, start the service with <code>ollama serve</code>.",
        ) + link("https://ollama.com/download/mac", "Download Ollama"),
      ) +
      s(
        "model",
        "2. Download a model",
        code("ollama pull qwen3:0.6b") +
          p(
            "This small model is useful for checking the connection. Choose a coding model suited to your available memory for real work; a successful connection is not a quality or speed guarantee.",
          ),
      ) +
      s(
        "connect",
        "3. Refresh and select",
        p(
          "Open <strong>Settings → Providers</strong> in Gyro and click <strong>Refresh models</strong> beside Ollama. Select an installed model in the chat model picker and send a short message. Success: a response appears in the conversation.",
        ),
      ) +
      s(
        "limits",
        "Know the boundaries",
        p(
          "Models advertising tool support can use governed Gyro tools; other models are chat-only. Model downloads are managed by Ollama. Refresh again after installing another model; no Gyro restart or API key is required.",
        ) +
          p(
            "Gyro accepts loopback HTTP Ollama endpoints and refuses redirects. Model loading can take time and use substantial memory, CPU, or GPU. Stop cancels an in-flight request.",
          ),
      ) +
      next(
        "/docs/troubleshooting/",
        "Troubleshoot the connection",
        "Runtime unavailable? Start Ollama. Model required? Pull a model, then refresh.",
      ),
  },
  {
    path: "/docs/troubleshooting/",
    title: "Troubleshoot Gyro",
    description:
      "Recover from macOS first-launch warnings, provider connection problems, missing local models, and unexpected diffs.",
    layout: "docs",
    body: () =>
      intro(
        "Find the next useful check.",
        "Start with the symptom. Change one thing, then try the small request again.",
      ) +
      s(
        "macos",
        "macOS blocks the app",
        p(
          "Confirm macOS 14+, the correct processor build, and the checksum. Try opening Gyro once, then use System Settings → Privacy &amp; Security → Open Anyway. If macOS reports damage or the checksum differs, stop and report the release. Never disable Gatekeeper globally.",
        ) + link("/install/#first-launch", "First-launch steps"),
      ) +
      s(
        "cli",
        "Provider not found or not signed in",
        p(
          "Open the provider CLI in Terminal and verify that it is installed and authenticated. Complete its own login flow. Recheck Settings → Providers in Gyro. If a CLI works outside Gyro but is not detected, include its version and the readiness message in a support report.",
        ),
      ) +
      s(
        "api",
        "API key or endpoint error",
        list([
          "HTTP 401: verify the key and access in the provider account.",
          "Endpoint unreachable: check the host, API path, and network. This does not prove the key was rejected.",
          "No models: check the /v1 prefix and configured model IDs.",
          "No remaining allowance shown: API integrations report observed usage; they do not expose a plan quota.",
        ]),
      ) +
      s(
        "ollama",
        "Local model does not answer",
        p(
          "Start Ollama, confirm that a model is installed, and refresh models in Gyro. A model may need time to load. Use Stop if necessary, then retry with a smaller model. Tool actions require a model advertising tool support.",
        ),
      ) +
      s(
        "review",
        "The change is not what you expected",
        p(
          "Confirm the active project and changed file, inspect the actual diff, and run a focused check. Do not repeatedly ask an agent to fix an unexplained failure without inspecting its output. Keep unrelated work safe and use version control.",
        ),
      ) +
      s(
        "support",
        "Prepare a useful support report",
        p(
          "Include the Gyro release, macOS version, processor, provider/CLI version, exact error, and minimal steps to reproduce. Remove API keys, tokens, private paths, and sensitive project content before sharing logs or screenshots. Report security issues privately.",
        ) +
          link(
            "https://github.com/wytzeh197/Gyro/blob/main/SUPPORT.md",
            "Support guide",
          ) +
          " · " +
          link(
            "https://github.com/wytzeh197/Gyro/security",
            "Security reporting",
          ),
      ),
  },
  {
    path: "/changelog/",
    title: "Gyro changelog",
    description:
      "Dated public Gyro releases, changes, and links to downloads and full release notes.",
    body: () =>
      intro(
        "The work keeps moving.",
        "Published releases, with the details that help you decide when to update.",
      ) +
      p(
        `Release history snapshot checked ${snapshot.retrievedAt}. ${link("https://github.com/wytzeh197/Gyro/releases", "All releases on GitHub")}.`,
      ) +
      `<div class="release-list">${releaseEntries()}</div>`,
  },
  {
    path: "/privacy/",
    title: "Privacy & Legal — Gyro",
    description:
      "Understand local data, configured model providers, telemetry defaults, and the Gyro public alpha license.",
    layout: "docs",
    body: () =>
      intro(
        "Privacy &amp; Legal.",
        "How Gyro handles your data. Last updated 22 July 2026.",
      ) + readFileSync(new URL("./privacy.html", import.meta.url), "utf8"),
  },
  {
    path: "/about/",
    title: "About Gyro",
    description:
      "Why Gyro brings coding agents, local commands, and reviewing changes into one open-source macOS workspace.",
    body: () =>
      intro(
        "A place to think. A space to build.",
        "Gyro brings the tools around AI-assisted coding into a workspace you can understand.",
      ) +
      s(
        "why",
        "Keep the work connected",
        p(
          "A coding task moves between a conversation, local commands, and the files that changed. Gyro exists to make those parts easier to follow together, while leaving the choice of provider with you.",
        ),
      ) +
      s(
        "principles",
        "Built around inspectable work",
        list([
          "Keep sessions and settings local. Explain when context goes to a provider.",
          "Make activity, command output, and file changes available for inspection.",
          "Keep the source open so product claims can be checked.",
        ]),
      ) +
      s(
        "today",
        "An open-source public alpha",
        p(
          "Gyro is available for macOS under Apache License 2.0. It is still alpha software and is not recommended for production. The current project has no Gyro account gate or paid hosted model plan.",
        ) + link("https://github.com/wytzeh197/Gyro", "Explore the source"),
      ) +
      next(
        "/product/",
        "See the workflow",
        "Start with a concrete example of how the pieces fit.",
      ),
  },
  {
    path: "/404.html",
    title: "Page not found — Gyro",
    description:
      "Find your way back to Gyro’s product, documentation, or downloads.",
    noindex: true,
    body: () =>
      intro(
        "That page isn’t here.",
        "The address may have changed. These are useful places to continue.",
      ) +
      `<div class="actions">${link("/", "Gyro home", "button primary")}${link("/docs/", "Documentation")}${link("/install/", "Download")}</div>`,
  },
];
