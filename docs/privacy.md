# Privacy

Gyro is local-first by default.

## Defaults

- No telemetry is sent by default.
- Provider keys are stored in macOS Keychain.
- Session logs are stored locally.
- User repositories are not modified with Gyro metadata unless the user opts in.

## Model Context

Only selected workspace context should be sent to configured model providers. Gyro should show sensitive actions clearly and redact common secret patterns from logs and context.

## Future Telemetry

Crash or usage reporting may be added later only as explicit opt-in. The UI must explain what is collected, where it is sent, and how to disable it.
