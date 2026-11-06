# Gyro Cloud staging

The desktop feature is off by default. Set `GYRO_CLOUD_ENABLED=1` before launching a staging desktop build. The client uses the existing Gyro staging Supabase project. New accounts sign up with a name, email, and password; the name is stored as `display_name` in the user metadata. Returning accounts use their password, or the original sign-in link or email code, which is requested only for existing accounts. When the project confirms new emails, the client asks for the confirmation link or code before signing in. Forgotten passwords use a recovery email; the app verifies its link or code and sets the new password, so the link must be copied into Gyro rather than opened in a browser. Signed-in accounts can set or change a password in Settings, which is also how accounts created with an email code add one.

Deploy `wrangler.toml` to the separate `gyro-cloud-staging` Worker with its private R2 binding. The config pins the existing staging issuer and JWKS. The Worker verifies ES256 tokens with JWKS. If JWKS verification is unavailable or fails, it asks the pinned Supabase issuer to verify the token. Legacy HS256 tokens always use issuer verification. Both paths require an authenticated account and reject anonymous sessions.

A cloud account stores one ciphertext object per chat and one small encrypted key check. The key check prevents two devices from initializing different keys for the same account. Keep the bucket private and avoid any policy that retains overwritten objects or exposes request headers in logs. The app preserves text the user sees, including paths or secrets that the user or a tool placed in the transcript itself.

## Verification

Run `node --test services/gyro-cloud/worker.test.mjs` for the local API contract and `cargo test -p gyro-desktop --lib gyro_cloud::tests` for archive recovery.

Before release, sign in on a staging Mac, save the recovery code, and upload a chat with a renamed title, code, Unicode, and tool output. On a second Mac or a separate macOS user account with fresh Gyro data and Keychain, sign in and recover with the code. Compare the transcript, then download again and verify the same local copy updates. Interrupt a replacement upload and a download, retry both, and confirm that deleting the cloud copy preserves the downloaded history.
