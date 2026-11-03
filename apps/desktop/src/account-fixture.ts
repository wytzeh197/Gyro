// Fixture-only Gyro Account and Cloud backend. Answers the `gyro_cloud` command
// so the real components can be reviewed in every state without a server.
import type { CloudStatus } from "./gyro-cloud";

const scenes: Record<string, CloudStatus> = {
  "signed-out": { enabled: true, signedIn: false },
  confirm: { enabled: true, signedIn: false },
  unavailable: { enabled: false },
  empty: {
    enabled: true,
    signedIn: true,
    unlocked: true,
    backupExists: true,
    profile: { email: "alex@example.com", displayName: "Alex", plan: null },
  },
  // A new account: no name yet, a long address, and no backup.
  new: {
    enabled: true,
    signedIn: true,
    unlocked: false,
    backupExists: false,
    profile: {
      email: "alex.morgan.longer.address@example.com",
      displayName: null,
      plan: null,
    },
  },
  locked: {
    enabled: true,
    signedIn: true,
    unlocked: false,
    backupExists: true,
    profile: { email: "alex@example.com", displayName: "Alex", plan: "Pro" },
  },
  ready: {
    enabled: true,
    signedIn: true,
    unlocked: true,
    backupExists: true,
    profile: { email: "alex@example.com", displayName: "Alex", plan: "Pro" },
  },
};

const sampleChats = [
  { id: "chat-1", title: "Design review", uploadedAt: "2026-11-03T10:00:00Z" },
  { id: "chat-2", title: "Release notes", uploadedAt: "2026-11-02T16:24:00Z" },
  { id: "chat-3", title: null, uploadedAt: "2026-10-28T09:12:00Z" },
];

export function installAccountFixture(scene: string) {
  const state: CloudStatus = structuredClone(scenes[scene] ?? scenes.ready!);
  let chats = scene === "empty" ? [] : sampleChats;
  let restored: string[] = [];
  let pendingName: string | null = null;
  const signIn = (email: unknown, displayName: string | null) => {
    state.signedIn = true;
    state.unlocked = false;
    state.backupExists = false;
    state.profile = { email: String(email), displayName, plan: null };
    return structuredClone(state);
  };
  const calls: Record<string, unknown>[] = [];
  Object.assign(window, {
    __accountCalls: calls,
    __TAURI_INTERNALS__: {
      invoke: async (
        command: string,
        { action }: { action: Record<string, unknown> },
      ) => {
        if (command !== "gyro_cloud") throw Error(`Unexpected ${command}`);
        calls.push(action);
        switch (action.type) {
          case "status":
            return structuredClone(state);
          case "updateProfile":
            state.profile!.displayName = String(action.displayName) || null;
            return { ...state.profile };
          case "signOut":
            state.signedIn = false;
            state.unlocked = false;
            state.profile = null;
            return structuredClone(state);
          case "sendCode":
            return null;
          case "signUp":
            // ?account=confirm stands in for a project that confirms new emails.
            if (scene === "confirm") {
              pendingName = String(action.name);
              return { confirmationRequired: true };
            }
            return signIn(action.email, String(action.name));
          case "passwordSignIn":
            if (action.password === "wrong-password") {
              throw "That email and password don’t match.";
            }
            return signIn(action.email, pendingName ?? "Alex");
          case "signIn":
            return signIn(action.email, pendingName);
          case "sendPasswordReset":
            return null;
          case "resetPassword":
            return {
              ...signIn(action.email, "Alex"),
              passwordError:
                action.password === "refused-password"
                  ? "You’re signed in, but your password didn’t change. Choose a stronger password."
                  : null,
            };
          case "changePassword":
            if (action.password === "same-password") {
              throw "That’s already your password.";
            }
            return null;
          case "generate":
            return { code: "GYRO-7K4M-2QXP-9TRD-B6WN-3HFC" };
          case "confirm":
            state.backupExists = true;
            state.unlocked = true;
            return null;
          case "recover":
            state.unlocked = true;
            return null;
          case "history":
            return [...restored];
          case "list":
            return { items: [...chats], cursor: null };
          case "delete":
            chats = chats.filter((chat) => chat.id !== action.id);
            return null;
          case "download":
          case "open":
            restored = [...new Set([...restored, String(action.id)])];
            return {
              title:
                chats.find((chat) => chat.id === action.id)?.title ??
                "Encrypted chat",
              createdAt: "2026-11-03T09:40:00Z",
              model: "claude-opus-5-5",
              messages: [
                {
                  kind: "user",
                  text: "Can you review the settings layout?",
                  timestamp: "2026-11-03T09:40:00Z",
                },
                {
                  kind: "assistant",
                  text: "The account row overflows the sidebar. **Fixing it** first.",
                  timestamp: "2026-11-03T09:41:00Z",
                  model: "claude-opus-5-5",
                },
              ],
            };
          default:
            throw Error(`Unexpected action ${String(action.type)}`);
        }
      },
    },
  });
}
