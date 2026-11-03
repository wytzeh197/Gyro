# Privacy

Gyro is local-first and does not require a Gyro account.

## Local data

- Sessions, workspace settings, logs, and app state are stored on the Mac.
- Provider credentials are stored through macOS Keychain when available.
- Gyro metadata is not written into user repositories unless the user chooses
  an action that does so.

## Gyro Cloud staging

Gyro Cloud requires sign-in when enabled and uploads chats you choose to back up. Your name, email, and password go to the account service when you sign up; Gyro does not keep your password on the device. The app compresses and encrypts chat text and titles before transfer. The service stores account and transfer metadata, including backup sizes and upload times. Your recovery code unlocks chats on another device. Removing a cloud copy leaves the local original and any downloaded history on the device.

## Model providers

Configured coding agents and model providers receive the prompts, selected
files, tool context, and other content needed for the user's request. The
provider's own privacy terms apply. Gyro does not operate a proxy service for
that traffic.

## Telemetry and website

App telemetry is off by default. The public website has no analytics,
advertising cookies, tracking pixels, account gate, remote fonts, or remote
images. Cloudflare serves the website, and GitHub serves release downloads.
Both providers may process ordinary request metadata under their own policies.

## Deletion

Sessions can be deleted inside Gyro. Removing Gyro.app uninstalls the app;
deleting `~/Library/Application Support/Gyro` also removes local sessions and
settings. Data already sent to a provider must be handled through that
provider.

The public-facing notice is available at
<https://usegyro.io/privacy/>.
