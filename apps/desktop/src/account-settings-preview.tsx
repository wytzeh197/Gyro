import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import "@gyro-dev/ui/styles.css";
import type { SettingsSectionId } from "@gyro-dev/ui";
import {
  AccountNavigation,
  AccountSettings,
  CloudSettings,
  useGyroAccount,
} from "./account-settings";
const state = {
  enabled: true,
  signedIn: true,
  unlocked: false,
  backupExists: false,
  profile: { email: "wytze@example.com", displayName: "Wytze", plan: null },
};
const calls: Record<string, unknown>[] = [];
Object.assign(window, {
  __accountCalls: calls,
  __TAURI_INTERNALS__: {
    invoke: async (
      _command: string,
      { action }: { action: Record<string, unknown> },
    ) => {
      calls.push(action);
      switch (action.type) {
        case "status":
          return structuredClone(state);
        case "updateProfile":
          state.profile.displayName = String(action.displayName);
          return { ...state.profile };
        case "signOut":
          state.signedIn = false;
          return structuredClone(state);
        case "signIn":
          state.signedIn = true;
          return structuredClone(state);
        case "sendCode":
          return null;
        case "generate":
          return { code: "FIXTURE-ONLY" };
        case "confirm":
          state.backupExists = true;
          state.unlocked = true;
          return null;
        case "recover":
          state.unlocked = true;
          return null;
        case "history":
          return [];
        case "list":
          return {
            items: [
              {
                id: "chat-1",
                title: "Design review",
                uploadedAt: "2026-11-03T10:00:00Z",
              },
            ],
            cursor: null,
          };
        default:
          throw Error("Unexpected action " + action.type);
      }
    },
  },
});
function Fixture() {
  const account = useGyroAccount();
  const [selected, select] = useState<SettingsSectionId>("account");
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "240px minmax(0,720px)",
        minHeight: "100vh",
      }}
    >
      <aside>
        <AccountNavigation
          account={account}
          selected={selected}
          onSelect={select}
        />
      </aside>
      <main className="gyro-settings-surface">
        {selected === "account" ? (
          <AccountSettings account={account} />
        ) : (
          <CloudSettings
            account={account}
            onAccount={() => select("account")}
          />
        )}
      </main>
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<Fixture />);
