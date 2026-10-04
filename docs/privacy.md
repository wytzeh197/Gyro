# Privacy

Gyro is local-first and does not require a Gyro account.

## Local data

- Sessions, workspace settings, logs, app state, local workspaces, worktrees,
  and browser captures are stored on the Mac under
  `~/Library/Application Support/Gyro`.
- API keys saved in Gyro provider settings are stored in macOS Keychain.
  Agent CLIs manage their own logins and may retain credentials and history
  outside Gyro. Environment-based credentials remain managed by the user.
- Gyro metadata is not written into user repositories unless the user chooses
  an action that does so.

## Model providers

Configured cloud agents and model providers receive prompts, attachments,
conversation context, and tool results needed for the task. Context can include
file contents and command output. An agent's own tools may read additional
files or contact external services. Review provider permissions and privacy
settings before sharing sensitive material. The provider's own policies apply;
Gyro does not operate a proxy service for model traffic.

Ollama defaults to a server on the Mac. A configured remote Ollama server or
custom model endpoint receives requests and context instead. Local inference
does not stop agent tools, package downloads, or other services from making
network requests.

## Telemetry and website

App telemetry is off by default. The website source includes no analytics,
third-party scripts, advertising cookies, tracking pixels, or account gate.
Its fonts, icons, and images are served from the website origin.

The app can fetch the public model catalogue from
`https://usegyro.io/model-catalog.json`. That request sends normal connection
metadata to the website host, without provider credentials or task content.
App update checks contact GitHub; provider CLI version checks can contact
provider services or package registries.

The website stores an explicitly chosen theme in browser local storage under
`gyro.site-theme`. That preference is not sent to Gyro or used for tracking;
clear the website's browser data to remove it. Website code does not set cookies.

Cloudflare serves the website. The Download, Install, and Changelog pages fetch
public release metadata directly from the GitHub API, without browser
credentials. GitHub also hosts downloads. Those connections send ordinary
request metadata, including IP address and browser information, to the service
receiving them. External links and configured providers use their own policies:

- [Cloudflare privacy policy](https://www.cloudflare.com/privacypolicy/)
- [GitHub privacy statement](https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement)

## Deletion

Delete individual sessions inside Gyro. Before deleting all app data, save any
work needed from Gyro's local workspaces and worktrees, then quit Gyro and delete
`~/Library/Application Support/Gyro`. This removes data in that folder; it does
not undo project changes or delete files elsewhere.

Before uninstalling, remove saved API keys with the **Remove** control in Gyro's
provider settings. Removing Gyro.app or its data folder does not remove Keychain
credentials. After uninstalling, Keychain Access can identify entries with
service `Gyro` and accounts beginning `provider:`; remove only the intended
entries. Removing a stored key does not revoke it with its provider.

Sign out of agent CLIs through their own tools and manage environment-based
credentials separately. Data already sent to a provider, remote endpoint,
GitHub, or another external service must be handled through that service's
data controls or privacy request process. Clear website browser data separately
to remove its theme preference.

The public-facing notice is available at <https://usegyro.io/privacy/>.
