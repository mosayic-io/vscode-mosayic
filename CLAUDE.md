# Mosayic VS Code Extension (vscode-mosayic)

## ⛔ HARD RULE: production is untouchable — data AND infrastructure

**NEVER add, update, or remove production data in Supabase.** No INSERT /
UPDATE / DELETE / UPSERT / TRUNCATE against the production database by any
route — SQL editor, `supabase` CLI, `psql`, PostgREST / service-role key,
admin endpoints, one-off scripts, anything.

**NEVER run anything on or against production.** Not even read-only. That
means: no `fly ssh console` into the API machine to run Python, shell or
SQL (it is a 256MB box — a second process OOM-kills the live API, which is
exactly what happened on 2026-08-23); no one-off scripts, REPLs or curls that
hold the production service-role key, DB connection string or any Fly
secret; no pulling those secrets out of Fly (`printenv`, `fly ssh`, `fly
secrets`) to use them from a dev machine; no "dry runs" or "previews"
against prod data, however read-only the SELECT. "Read-only" describes the
query, not the risk — the route, the credentials and the machine are the
risk, and they are John's.

**Allowed, and only these:** publishing releases (the migrations workflow
rides them — schema changes and backfills ship as migrations, nothing else);
reading the *public* surface like any visitor (`/health`, a live site bundle,
the marketplace listing); and status/log read-outs from the tooling's own
commands — `fly status`, `fly logs`, `fly machine status`, `gh run view`,
`vsce show`. If a task wants anything from production beyond that — a count,
a preview table, a backfill dry run, a name lookup — **stop and ask John**:
he runs the query himself in the Supabase dashboard and pastes the result,
or the need ships as a release (a migration, an admin-panel page). Never as
a side effect of something else, and never because it seemed harmless.

## What is Mosayic

Mosayic is a SaaS platform for guided mobile app development. This repo is the **VS Code extension** — the execution bridge between the Mosayic web dashboard and the user's local machine. It receives commands from the backend via WebSocket, executes them as local shell processes, and streams output back.

### Related Repos

- **Frontend**: `../mosayue` — Vue 3 SPA dashboard. Users trigger actions here.
- **Backend**: `../mosayic-api` — FastAPI service. Relays commands between dashboard and this extension.

## Tech Stack

- **Language**: TypeScript 5.7
- **Platform**: VS Code Extension API (engine ^1.96.0)
- **WebSocket**: `ws` library 8.20
- **Build**: Plain `tsc` (no bundler — native Node.js ES2022 modules)
- **Linting**: ESLint 9 (flat config)
- **Package manager**: npm

## Project Structure

```
vscode-mosayic/
├── src/
│   ├── extension.ts            # Main entry: activation, command registration, lifecycle
│   ├── config.ts               # Configuration helpers (getApiUrl)
│   ├── claude.ts               # The Claude Code bridge: install/sign-in status, silent install, open a panel, headless `claude -p` runs
│   ├── auth/
│   │   ├── authProvider.ts     # OAuth2 auth provider: login, token storage, refresh
│   │   └── uriHandler.ts      # URI callback handler for OAuth redirect
│   └── ws/
│       └── wsClient.ts        # WebSocket client: connect, reconnect, command execution
├── out/                        # Compiled JS output (generated, not committed)
├── package.json                # Extension manifest: commands, settings, activation
├── tsconfig.json               # Strict mode, ES2022 target, Node16 modules
├── eslint.config.mjs           # ESLint 9 flat config
└── .vscode/
    ├── launch.json             # F5 debug config (Extension Host + tests)
    └── tasks.json              # Compile and watch tasks
```

## Extension Activation & Lifecycle

**Activation**: `onStartupFinished` — activates automatically when VS Code finishes loading.

**Startup sequence** (`src/extension.ts`):
1. Register URI handler for OAuth callbacks, the dashboard hand-off (`/handoff`), `/wake` and `/focus`
2. Initialize authentication provider (reads stored sessions)
3. Create WebSocket client
4. If already authenticated, auto-connect WebSocket
5. Subscribe to auth session changes — connect on login, disconnect on logout
6. Register `vscode-mosayic.signIn` and `vscode-mosayic.signOut` commands

## Authentication

**Provider**: Custom OAuth2 via Mosayic backend + Supabase (Google / GitHub — chosen in a QuickPick at sign-in).

**Login flow** (`src/auth/authProvider.ts`):
1. Extension generates a random nonce
2. Requests login URL from `GET {apiUrl}/auth/vscode/login?nonce=...&callback_uri=...`
3. Opens external browser for OAuth with the chosen provider (`provider` query param)
4. Backend completes PKCE flow, redirects to `vscode://mosayic.vscode-mosayic/auth-callback`
5. Extension receives tokens (access, refresh) + user info via URI query params
6. Tokens stored in VS Code's `secretStorage` (OS-level credential manager)

**Dashboard hand-off** (since 0.2.5, `createSessionFromHandoff` + the `vscode-mosayic.handoff` command) — the primary path for new students:
1. The signed-in dashboard calls `POST /auth/vscode/handoff` and opens `vscode://mosayic.vscode-mosayic/handoff?code=…&email=…` (one-time code, 60 s; the email is a display hint)
2. `UriEventHandler` routes `/handoff` to the command; VS Code offers to install the extension first if it's missing and replays the URI
3. Already signed in as that email → just reconnect. Otherwise a **modal confirm** names the account and where the request came from (login-CSRF guard: anyone can craft a `vscode://` link)
4. `POST /auth/vscode/exchange` with the code → the extension's own session (its own refresh chain, never the browser's); refused if the minted session's email ≠ the hint
5. Stored like a classic sign-in (replacing any previous session); any failure offers the classic "Mosayic: Sign In"

**Token refresh** (`authProvider.ts:83-128`):
- Triggered when WebSocket gets a 403
- POST to `{apiUrl}/auth/vscode/refresh` with refresh token
- On failure: signs user out and prompts re-login

**Session**: Single account only (`supportsMultipleAccounts: false`).

## WebSocket Communication

**Connection** (`src/ws/wsClient.ts`):
- URL: `ws[s]://{apiUrl}/ws` (derived from `mosayic.apiUrl` setting)
- Auth: `Authorization: Bearer <access_token>` header
- Keepalive: ping every 30 seconds

**Reconnection**:
- Exponential backoff: [1s, 2s, 5s, 10s, 30s]
- Max 10 attempts
- On 403: attempts token refresh, then retries
- After max retries: prompts user to sign in again
- **Two close codes mean "don't"**: **4001** (another window took the
  connection → `standby`) and **4002** (the account isn't a Kealy Studio
  member → `members-only`). Neither reconnects, neither refreshes the token.

**Members only** (since 0.2.4): Mosayic is part of the Kealy Studio full
membership, and the backend enforces it on the handshake — a valid token from
a free account is **accepted and then closed with 4002** (after accept on
purpose: a pre-accept rejection arrives here as a bare HTTP 403, which the
close handler reads as an expired token). The extension stands down: state
`members-only`, `$(lock) Mosayic: members only` in the status bar, one
notification per rejected attempt ("Open kealy.studio" / "Sign out" to switch
account — vocabulary is "full membership" / "Kealy Studio", never "premium").
Clicking the status bar item runs `vscode-mosayic.connect`, the explicit
retry for after they've joined. The marketplace listing is public and sign-in
accepts any Google/GitHub account, so this is the only thing standing between
a free sign-up and a live command channel.

**Message protocol** (JSON):

Incoming from backend:
```json
{ "type": "command", "request_id": "uuid", "command": "shell command" }
```

Outgoing to backend:
```json
{ "type": "hello", "platform": "win32", "arch": "x64",
  "shell": "gitbash", "capabilities": ["native_file_patch"] }
{ "type": "command_output", "request_id": "uuid", "text": "partial stdout" }
{ "type": "command_result", "request_id": "uuid", "stdout": "...", "stderr": "...", "exit_code": 0 }
{ "type": "ping" }
```

`hello` goes out once per connect. `shell` and `capabilities` are new in 0.2.3;
`home` (the user's home directory, `os.homedir()`, native path style — the
dashboard's default project folder is `<home>/projects`) is new in 0.2.6.

- **`shell`** (`gitbash` | `cmd` | `pwsh` | `posix`) is diagnostic — the backend
  logs it, and `cmd` is a red flag there because everything it relays is POSIX.
- **`capabilities`** (`EXTENSION_CAPABILITIES` in `wsClient.ts`) is how the
  backend picks a route an older extension wouldn't understand; it treats a
  missing list as "none" and keeps the old behaviour. **A name here is a
  promise** — only add one when the behaviour it names is correct on every
  platform. `native_file_patch` says `read_file`/`write_file` resolve paths
  correctly on Windows too, which is what lets the backend patch app.json
  through them instead of relaying `node -e '<js>'` into a shell that may not
  be POSIX. `claude_bridge` (0.2.6) says the Claude Code messages below are
  understood and `hello` carries `home`.

**The Claude Code bridge** (`src/claude.ts`, 0.2.6). Mosayic builds with
Claude Code, so the dashboard's onboarding has to know it's there — and the
Start page hands it prompts. Anthropic's extension is not ours, so the bridge
uses public seams only: the extension registry, the `claude` binary the
extension ships (`<extensionPath>/resources/native-binary/claude`, which
shares one credential store with any PATH-installed `claude`; the PATH
fallback gets the nvm preamble), the observed
`claude-vscode.editor.open(sessionId, initialPrompt)` command (it PRE-FILLS
the input box, it does not send — a terminal running `claude` is the
fallback), and the documented headless CLI (`claude -p`). Messages, each
answered by `<type>_result` with the same `request_id`:

| Incoming | Does | Reply |
|----------|------|-------|
| `claude_status` | `getExtension('anthropic.claude-code')` + `claude auth status` (JSON: `loggedIn`, `email`, `subscriptionType`) | `extension_installed`, `extension_version`, `cli` (`bundled`/`path`/null), `logged_in`, `email`, `subscription_type`, `auth_method`, `error` |
| `claude_install` | `workbench.extensions.installExtension`, waits for the registry | `status` installed / already_installed / error |
| `claude_open` `{prompt?, path?}` | Opens a panel, prompt waiting in the box (a bare open shows Claude's sign-in when logged out) | `status` opened / not_installed / error, `via` panel / terminal |
| `claude_run` `{prompt, path}` | `claude -p <prompt> --permission-mode acceptEdits --output-format stream-json --verbose` in `path` (allowed-roots checked), progress distilled to human lines | `claude_output` `{text}` per line, then `claude_run_result` `{exit_code, result_text, error}` |
| `claude_cancel` | Kills an in-flight run | — |

None of it goes through the command consent filter: binary and flags are
fixed here, the prompt is one argv entry (no shell), so the backend cannot
turn a prompt into a shell command. Claude Code's own permission rules still
apply — headless, anything but an edit is denied.

## Command Execution

When a `command` message arrives (`wsClient.ts:153-217`):

1. **User consent** (if `mosayic.confirmCommands` is true — the default):
   - Shows warning dialog with redacted command
   - Options: "Allow", "Allow All" (disables future prompts), "Deny"
2. **Spawns shell process** in the first workspace folder
3. **Streams stdout** back as `command_output` messages
4. **Sends final result** as `command_result` with stdout, stderr, exit_code
5. **Limits**: 120s timeout, 10 MB max output buffer per stream

**Security features**:
- Credential redaction in logs (passwords, tokens, keys, Bearer headers)
- Plaintext HTTP warning for remote (non-localhost) connections
- User consent prompt before execution (default on)

## Registered Commands

| Command ID | Label | Description |
|------------|-------|-------------|
| `vscode-mosayic.signIn` | Sign in to Mosayic | Opens browser for OAuth login (2-min timeout) |
| `vscode-mosayic.signOut` | Sign out of Mosayic | Clears session, disconnects WebSocket |

## Configuration Settings

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `mosayic.apiUrl` | string | `http://127.0.0.1:8080` | Mosayic API server URL |
| `mosayic.confirmCommands` | boolean | `true` | Prompt before executing commands from server |

Settings are read via `vscode.workspace.getConfiguration('mosayic')` in `src/config.ts`.

## Build & Development

```bash
# Install dependencies
npm install

# Compile once
npm run compile

# Watch mode (continuous compilation)
npm run watch

# Lint
npm run lint
```

**Debugging**: Press F5 in VS Code to launch an Extension Development Host with the extension loaded. Debug configurations in `.vscode/launch.json`.

**Packaging for distribution**:
```bash
npm run vscode:prepublish  # Compiles TypeScript
vsce package               # Creates .vsix file
```

**No bundler** — output is native Node.js modules in `out/`. The `vscode:prepublish` script just runs `tsc`.

## Key Architectural Notes

- **No webviews or custom UI** — all interaction is via VS Code command palette, native dialogs, and the `Mosayic WebSocket` output channel.
- **Single connection per user** — the WebSocket manager in the backend tracks one connection per user ID. New connections replace old ones: the losing socket is closed with code **4001**, and the extension responds by *standing down* (state `standby`, "connected in another window" in the status bar) instead of reconnecting — auto-reconnecting on 4001 would make two open windows steal the connection from each other forever. The user reclaims explicitly via the status bar / notification button / the dashboard's "Open VS Code" wake (all of which run `vscode-mosayic.connect`); the newly displaced window then stands down in turn.
- **Extension is stateless** — it doesn't store project data. It just authenticates and executes commands sent by the backend. Project state lives in Supabase, managed by the backend.
- **Commands execute in workspace root** — the first open workspace folder is used as the working directory for all shell commands.
