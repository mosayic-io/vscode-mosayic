# Changelog

All notable changes to the Mosayic VS Code extension are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.6] - 2026-09-04

### Added
- **The Claude Code bridge** (`src/claude.ts`, capability `claude_bridge`). Mosayic builds with Claude Code, and the dashboard's onboarding now checks for it the way it checks for VS Code — through this extension, since a browser can see nothing on the machine. Four new backend messages: `claude_status` (is the `anthropic.claude-code` extension installed, and is it signed in — `claude auth status` run on the binary that extension ships under `resources/native-binary/`, which shares one credential store with any PATH-installed `claude`; falls back to PATH with the nvm preamble), `claude_install` (VS Code's own `workbench.extensions.installExtension`, no marketplace page), `claude_open` (a Claude Code panel via `claude-vscode.editor.open`, optionally with a prompt waiting in its input box — never sent on the student's behalf; a bare open shows Claude's sign-in when logged out; falls back to a terminal running `claude`), and `claude_run` (headless `claude -p <prompt> --permission-mode acceptEdits --output-format stream-json` in a backend-named project folder, progress distilled to human lines — what Claude says, which file it edits — and streamed back as `claude_output`, then `claude_run_result`; `claude_cancel` kills it). Nothing here passes through the command consent filter: the binary and flags are fixed in the extension and the prompt travels as one argv entry, never through a shell, so the backend cannot turn a prompt into a shell command. Claude Code's own permission rules still govern the prompt — in headless mode anything beyond an edit is denied, never silently allowed.
- `hello` now carries `home` — the user's home directory as Node sees it (`os.homedir()`), in the platform's native path style. The dashboard's Start page proposes `<home>/Mosayic` as the project folder with it, no folder picker.

## [0.2.5] - 2026-09-04

### Added
- **Sign in from the dashboard, no second Google sign-in.** The dashboard's new "Connect VS Code" button opens `vscode://mosayic.vscode-mosayic/handoff?code=…&email=…` with a one-time, 60-second code minted for the account signed in to the dashboard. The extension asks the student to confirm (the dialog names the account and says the request came from the dashboard — anyone can craft a `vscode://` link, so a link nobody just clicked for is easy to refuse), trades the code for a session of its own at `POST /auth/vscode/exchange`, and connects. Already signed in as that account: it just reconnects. Signed in as someone else: the dialog offers to switch, and the old socket and its "Allow All" consent are dropped first. If the minted session belongs to anyone other than the named account the hand-off is refused. Any failure (an expired code, a backend that doesn't know the endpoint, a mismatched environment) offers the classic "Mosayic: Sign In" instead. VS Code itself offers to install the extension when the URI arrives and it isn't there, so one dashboard button now covers install + sign-in + connect. Needs mosayic-api with the hand-off endpoints (shipped alongside).

## [0.2.4] - 2026-08-23

### Changed
- Mosayic is part of the Kealy Studio full membership, and the backend now says so on the WebSocket: a valid sign-in from an account without one is accepted and closed with code **4002**. The extension answers by standing down — state `members-only`, `$(lock) Mosayic: members only` in the status bar — with a single notification offering kealy.studio or a sign-out to switch account, instead of what an older extension does with the same close: ten reconnect attempts over three minutes and then a "session expired" prompt that sends the student to re-sign-in with the same account. No token refresh is attempted (the token was fine) and no auto-reconnect (the answer wouldn't change); clicking the status bar item retries explicitly, which is the path after joining. Needs a backend that sends the code (mosayic-api's members-only gate, shipped alongside); against an older backend nothing changes.

## [0.2.3] - 2026-08-10

### Fixed
- Windows: Git Bash is now also found at per-user install locations — `%LOCALAPPDATA%\Programs\Git` (Git for Windows' "install for me only" option, and winget) and scoop's `~\scoop\apps\git\current`. Previously only the two system-wide `Program Files` paths were probed, so a student without admin rights had a perfectly good Git Bash and still got the silent cmd.exe fallback, where every backend command dies with an inscrutable syntax error.
- Windows: file and folder paths sent by the backend are no longer rejected as "outside allowed directories". The allowed-root check built its prefix with a hardcoded `/`, which never matches a backslash path, so on Windows everything except the home directory itself failed the guard — this broke `write_file` (the push lesson's `google-services.json` install) and `open_folder`. The check now uses `path.relative`, which is separator-aware and also stops `/home/bobby` passing a `/home/bob` root.

### Added
- Falling back to cmd.exe is no longer silent: the output channel logs a warning naming the cause, and a once-per-session notification offers a link to the Git for Windows download.
- The `hello` handshake now reports the resolved shell (`gitbash` / `cmd` / `pwsh` / `posix`) and a capability list. The shell is diagnostic — a student whose commands are failing shows up in the API logs as `shell=cmd` — and `native_file_patch` tells the backend it can patch JSON files through `read_file`/`write_file` instead of relaying `node -e '<js>'` through a shell that may not be POSIX. Older extensions send neither field and keep the existing behaviour.

## [0.2.2] - 2026-08-05

### Changed
- When the backend closes the WebSocket with code 4001 (the user's connection was claimed by another VS Code window), the extension now stands down instead of reconnecting: state `standby`, "connected in another window" in the status bar. Auto-reconnecting on 4001 made two open windows steal the connection from each other forever. The user reclaims explicitly via the status bar item, the notification button, or the dashboard's "Open VS Code" wake (all run `vscode-mosayic.connect`); the newly displaced window then stands down in turn.

## [0.2.1] - 2026-08-03

### Fixed
- Windows: relayed commands now run through Git Bash. The `auto` value of `mosayic.windowsShell` prefers Git Bash (probed at the known install paths, overridable via `MOSAYIC_GIT_BASH`) and only falls back to cmd.exe when Git Bash isn't found. The backend's scaffold commands are POSIX (`[ -f … ]`, `mv`, `&&` chains) and died in cmd.exe with "The syntax of the command is incorrect" / "'true' is not recognized" — the first Windows student through the scaffold hit exactly that.

## [0.2.0] - 2026-07-27

### Added
- Sign-in provider picker: "Sign in to Mosayic" now opens a QuickPick (Google / GitHub) before launching the browser, passed to the backend as the `provider` param on `/auth/vscode/login`. Requires mosayic-api ≥ 0.10.0 for GitHub; older backends ignore nothing — the param simply wasn't sent before, and Google remains the default.

## [0.0.12] - 2026-04-23

### Added
- `mosayic.windowsShell` setting (`auto` | `cmd` | `gitbash` | `pwsh`, default `auto`). Picks the shell used by `child_process.spawn` for Mosayic commands on Windows. `gitbash` / `pwsh` resolve to known absolute install paths, never via a PATH lookup.
- `Mosayic: Check Docker` command, plus a fire-and-forget Docker preflight that runs on activation. Classifies Docker as `ok` / `not-installed` / `daemon-down` / `unknown` from a 3s `docker info` probe. Surfaces a warning notification at most once per session with `Install Docker Desktop` (opens docker.com) and `Re-check` actions. Does not attempt to install Docker — the install is UAC/EULA/WSL2-gated and can't be reliably automated.

### Fixed
- Shell selection on Windows no longer passes the bare string `"bash"` to `spawn`. On machines with the WSL optional feature enabled, `C:\Windows\System32\bash.exe` is the WSL distro launcher, not a POSIX bash — every Mosayic command was running inside the user's Ubuntu distro, where none of their Windows-installed CLI tools (gh.exe, npm.cmd, supabase.exe, docker.exe, …) existed. The new resolver defaults to cmd.exe (PATHEXT covers `.exe`/`.cmd`/`.ps1`, which is every CLI the backend invokes) and only uses Git Bash / PowerShell when explicitly selected — and then only from hard-coded install paths.
- The managed-terminal pty (dev servers, `npm run start`, etc.) now routes through the same shell resolver, so the `windowsShell` setting applies uniformly to background commands and visible terminals.

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
