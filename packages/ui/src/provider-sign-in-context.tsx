import { createContext } from "react";

export type ProviderSignInPhase =
  | "starting"
  | "waiting"
  | "not-installed"
  | "installing"
  | "failed";

/**
 * One provider's sign-in as the model popover shows it. The host runs the
 * provider's login CLI out of sight and reports only what a person acts on.
 */
export type ProviderSignIn = {
  providerId: string;
  phase: ProviderSignInPhase;
  /** Sign-in or device verification page the CLI printed. */
  url?: string;
  /** One-time code to enter on the verification page. */
  deviceCode?: string;
  /** The CLI is reading a pasted authorization code. */
  acceptsCode?: boolean;
  /** Shell command that installs the missing CLI, when Gyro can run it. */
  installCommand?: string;
  message?: string;
};

export type ProviderSignInState = {
  signIns: Partial<Record<string, ProviderSignIn>>;
  openLink: (providerId: string) => void;
  submitCode: (providerId: string, code: string) => void;
  cancel: (providerId: string) => void;
  showDetails: (providerId: string) => void;
  install: (providerId: string) => void;
};

export const ProviderSignInContext = createContext<ProviderSignInState>({
  signIns: {},
  openLink: () => {},
  submitCode: () => {},
  cancel: () => {},
  showDetails: () => {},
  install: () => {},
});
