// Standalone fixture: the model popover in every inline sign-in phase.
import { useLayoutEffect } from "react";
import { createRoot } from "react-dom/client";
import type { ProviderSignIn, ProviderSignInState } from "@gyro-dev/ui";
import { ComposerModelRail } from "../../../packages/ui/src/composer-model-rail";
import { ProviderSignInContext } from "../../../packages/ui/src/provider-sign-in-context";
import "@gyro-dev/ui/styles.css";

const providers = [
  {
    id: "anthropic",
    label: "Anthropic",
    connection: "CLI" as const,
    connected: false,
    models: [],
  },
  {
    id: "openai",
    label: "OpenAI",
    connection: "CLI" as const,
    connected: false,
    models: [],
  },
];

const fixtures: { label: string; signIn?: ProviderSignIn }[] = [
  { label: "Not connected" },
  { label: "Starting", signIn: { providerId: "anthropic", phase: "starting" } },
  {
    label: "Browser sign-in with paste-back",
    signIn: {
      providerId: "anthropic",
      phase: "waiting",
      url: "https://claude.com/cai/oauth/authorize?code=true",
      acceptsCode: true,
    },
  },
  {
    label: "Device code",
    signIn: {
      providerId: "anthropic",
      phase: "waiting",
      url: "https://auth.openai.com/codex/device",
      deviceCode: "BQ7X-4KLM9",
    },
  },
  {
    label: "CLI missing",
    signIn: {
      providerId: "anthropic",
      phase: "not-installed",
      installCommand: "npm install -g @anthropic-ai/claude-code",
      message: "Anthropic needs Claude Code, which isn't installed yet.",
    },
  },
  {
    label: "Installing",
    signIn: { providerId: "anthropic", phase: "installing" },
  },
  {
    label: "Failed",
    signIn: {
      providerId: "anthropic",
      phase: "failed",
      message: "Anthropic sign-in timed out. Try again when you're ready.",
    },
  },
];

function Fixture({ label, signIn }: (typeof fixtures)[number]) {
  const state: ProviderSignInState = {
    signIns: signIn ? { anthropic: signIn } : {},
    openLink: () => {},
    submitCode: () => {},
    cancel: () => {},
    showDetails: () => {},
    install: () => {},
  };
  return (
    <section>
      <h2>{label}</h2>
      <div className="frame gyro-composer-control-model">
        <ProviderSignInContext.Provider value={state}>
          <ComposerModelRail
            activeProviderId="openai"
            activeModelId="gpt"
            id={`rail-${label.replace(/\W+/g, "-")}`}
            onConnect={() => {}}
            onManageProviders={() => {}}
            onSelectModel={() => {}}
            placement="down"
            providers={providers.map((provider) => ({ ...provider }))}
            renderLogo={(provider) => (
              <span className="gyro-provider-logo">{provider.label[0]}</span>
            )}
          />
        </ProviderSignInContext.Provider>
      </div>
    </section>
  );
}

function Preview() {
  useLayoutEffect(() => {
    document.documentElement.dataset.theme = "dark";
  }, []);
  return (
    <main className="sign-in-preview">
      <style>{`
        html, body, #root { margin: 0; min-height: 100%; }
        .sign-in-preview { display: grid; grid-template-columns: repeat(4, 340px); gap: 24px 20px; padding: 24px; background: var(--gyro-app); color: var(--gyro-text); font-family: var(--gyro-font-sans); }
        .sign-in-preview h2 { margin: 0 0 8px; color: var(--gyro-muted); font-size: 12px; font-weight: 400; }
        .sign-in-preview section { min-height: 380px; }
        .sign-in-preview .frame { position: relative; height: 1px; }
        .sign-in-preview .frame > .gyro-model-rail { left: 0; height: 340px; translate: none !important; animation: none !important; }
      `}</style>
      {fixtures.map((fixture) => (
        <Fixture key={fixture.label} {...fixture} />
      ))}
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<Preview />);
