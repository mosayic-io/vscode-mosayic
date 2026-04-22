# Changelog

All notable changes to the Mosayic VS Code extension are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.0.11] - 2026-04-22

### Fixed
- `isShellAbuseCommand` now ignores characters inside single-quoted regions, matching POSIX shell semantics: inside `'…'` shell interprets nothing, so a `;`, `$(`, or backtick there is not a real separator/substitution. Without this, the Supabase setup flow's LAN-IP and `.env`-patch probes — `. "$HOME/.nvm/nvm.sh" >/dev/null 2>&1 && node -e '…;…;…'`, where the JS payload is shlex-quoted — were tripping the abuse filter on `;` inside the Node `-e` string, falling out of the allowlist, and hanging on an unseen consent prompt. Double-quoted content is left intact on purpose so shell-level `$()` / backtick substitution is still caught.

## [0.0.10] - 2026-04-22

### Changed
- Allowlist extended with `.` (POSIX `source` builtin). The Supabase setup flow's Node/nvm probes (`. "$HOME/.nvm/nvm.sh" >/dev/null 2>&1 && node -v`, and the LAN-IP and `.env`-patch `node -e` invocations) all begin with `.`, so on macOS/Linux they were triggering the consent prompt and hanging the setup until the backend timed out. `&&` chaining is still honored by `isAllowlistedCommand`, so only the first token needs listing.

## [0.0.9] - 2026-04-22

### Changed
- Command allowlist updated to match the current backend probe set: added `test`, `[`, `nvm`, `docker`, `hostname`, and `lsof`; removed `firebase`. Previously, the Supabase setup flow's nvm probe (`test -s "$HOME/.nvm/nvm.sh"`) was not allowlisted, so the extension raised a consent prompt that the user — looking at the browser dashboard — never saw. The backend's 15-second `nvm_check` step then timed out with `nvm_check_timeout`. With `test` allowlisted, the probe auto-approves and the setup flow proceeds.

## [0.0.8] - 2026-04-22

### Changed
- `pick_folder` no longer calls `vscode.env.openExternal` to refocus the dashboard. After the user selects a folder, the extension shows a VS Code information message prompting them to switch windows. Removes the OS-level "allow this page to open VS Code / browser?" prompts and the stray dashboard tabs `openExternal` used to spawn. The `return_url` field on `pick_folder` messages is no longer read (see `mosayic-api/docs/ws-protocol.md`).

## [0.0.7] - 2026-04-20

### Added
- `mosayic.environment` setting (`prod` | `dev` | `custom`, default `prod`) — picks which backend the extension talks to without requiring the user to paste a URL. Dev maps to the local backend, prod to the Cloud Run service, custom falls back to `mosayic.apiUrl`.
- `Mosayic: Switch Backend…` command — QuickPick of prod/dev/custom that writes the setting and clears the existing session in one step. Hidden from the command palette unless `mosayic.showDevCommands` is `true`, so it doesn't surface to end users.
- `mosayic.showDevCommands` setting (default `false`) — gates developer-only commands in the palette via a `when` clause.

### Changed
- `getApiUrl()` now resolves from `mosayic.environment` with hardcoded `PROD_API_URL` and `DEV_API_URL` constants. `mosayic.apiUrl` is only consulted when environment is `custom`.
- On activation, if the resolved API URL no longer matches the URL that issued the stored session, the extension clears the session automatically — prevents sending prod tokens to a dev backend after a switch.

## [0.0.5] - 2026-04-20

### Added
- New `vscode-mosayic.focus` command, wired to `vscode://mosayic.vscode-mosayic/focus`. Brings the most recently spawned Mosayic terminal to the front so dashboard hand-offs (e.g. "Create iPhone development build") land the user on the running build instead of whatever VS Code happened to be showing.

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
