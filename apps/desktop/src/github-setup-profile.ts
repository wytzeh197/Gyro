import type { CommandProfile, GithubSetupAction } from "@gyro-dev/ui";

const DISPLAY_NAMES: Record<GithubSetupAction, string> = {
  install: "Install GitHub CLI",
  connect: "Connect GitHub",
  publish: "Publish to GitHub",
  switch: "Switch GitHub Account",
};

// Hostnames come from `gh` itself, but they are still spliced into shell
// source, so anything other than a plain DNS name falls back to github.com.
function safeHost(host: string | undefined) {
  return host && /^[A-Za-z0-9.-]+$/.test(host) ? host : "github.com";
}

/**
 * The shell script behind each GitHub setup button. They run in a visible
 * terminal because each one can prompt: a browser code, a Homebrew password,
 * a choice of account.
 */
export function githubSetupScript(
  action: GithubSetupAction,
  host?: string,
  expectedHasCommits?: boolean,
): string {
  const h = safeHost(host);
  // Pushes over HTTPS should use the same login, or the first `git push`
  // asks for a password GitHub no longer accepts.
  const login = `gh auth login --hostname ${h} --web --git-protocol https && gh auth setup-git --hostname ${h}`;
  switch (action) {
    case "install":
      return [
        "if command -v brew >/dev/null 2>&1; then brew install gh;",
        'else echo "Homebrew is not installed. Get the GitHub CLI from https://cli.github.com, then refresh GitHub in Gyro."; exit 1; fi',
      ].join(" ");
    case "connect":
      return login;
    case "publish": {
      // A brand-new folder needs a repository first, and `--push` fails
      // until there is a commit to push.
      const init = "{ git rev-parse --git-dir >/dev/null 2>&1 || git init; }";
      const hasHead = "git rev-parse --verify -q HEAD >/dev/null 2>&1";
      const create = "gh repo create --private --source . --remote origin";
      if (expectedHasCommits === undefined) {
        return `${init} && if ${hasHead}; then ${create} --push; else ${create}; fi`;
      }
      const check = expectedHasCommits ? hasHead : `! ${hasHead}`;
      return [
        `{ ${check} || { echo "Local commits changed. Refresh Source Control in Gyro and try again."; exit 1; }; }`,
        init,
        expectedHasCommits ? `${create} --push` : create,
      ].join(" && ");
    }
    case "switch":
      // `gh auth switch` needs a second account; offer to add one instead.
      return [
        `if [ "$(gh auth status --hostname ${h} 2>&1 | grep -c 'Logged in to')" -gt 1 ];`,
        `then gh auth switch --hostname ${h} && gh auth setup-git --hostname ${h};`,
        `else echo "Only one account is signed in to ${h}. Sign in with another:"; ${login}; fi`,
      ].join(" ");
  }
}

export function githubSetupProfile(
  action: GithubSetupAction,
  host?: string,
  expectedHasCommits?: boolean,
): CommandProfile {
  return {
    args: ["-c", githubSetupScript(action, host, expectedHasCommits)],
    command: "sh",
    displayName:
      action === "publish" && expectedHasCommits !== undefined
        ? expectedHasCommits
          ? "Create repository and push commits"
          : "Create private repository"
        : DISPLAY_NAMES[action],
    id: `github-${action}`,
    workingDirectory: null,
  };
}
