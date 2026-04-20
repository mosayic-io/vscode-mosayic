# Changelog

All notable changes to the Mosayic VS Code extension are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.0.4] - 2026-04-20

### Added
- `pick_folder` messages accept an optional `return_url`; after the native folder picker resolves (or is cancelled) the extension calls `vscode.env.openExternal` to refocus the dashboard tab, so the user is not stranded in an empty VS Code window mid-onboarding.
- `vscode-mosayic.connect` command, wired to the `vscode://mosayic.vscode-mosayic/wake` URI. The dashboard's "Open VS Code" button uses it to force a fresh WebSocket connection (resetting the retry counter) instead of dispatching a no-op `vscode://` URI.
- `open_folder` messages accept an optional `notice: "scaffold_complete"`. When present, after the workspace reload the extension pops a modal dialog telling the user the project is ready and to return to the dashboard.

### Fixed
- Spawning a shell command no longer fails with `spawn /bin/sh ENOENT` when the workspace folder is stale (deleted on disk) or a non-local URI (remote / virtual). The cwd is validated and falls back to the user's home directory and finally `/`.

## [0.0.3] - 2026-04-20

### Changed
- `mosayic.apiUrl` now defaults to the production backend (`https://mosayic-api-service-336793731775.us-east1.run.app`). Override in VS Code settings for local/staging backends.

### Added
- Bundled output with esbuild — single minified `out/extension.js` instead of shipping `node_modules`.

## [0.0.2] - 2026-04-20

### Fixed
- Activation failed with "command 'vscode-mosayic.signIn' not found" because the packaged VSIX omitted the `ws` runtime dependency.

## [0.0.1] - 2026-04-19

### Added
- Initial release.
- Google OAuth sign-in via the Mosayic backend (PKCE flow), with tokens stored in VS Code's secret storage.
- Persistent WebSocket connection to the Mosayic backend with exponential-backoff reconnect and 30-second keepalive.
- Remote command execution in the active workspace folder, with streamed stdout and a final result message.
- Per-command consent prompts (`allowlisted`, `always`, `never`) with credential redaction in logs.
- Commands: `Mosayic: Sign In`, `Mosayic: Sign Out`, `Mosayic: Show Logs`, `Mosayic: Reset Command Prompts`.
- Configuration: `mosayic.apiUrl`, `mosayic.confirmCommands`.
