# Mosayic VS Code Extension (vscode-mosayic)

## ⛔ HARD RULE: production data is untouchable

**NEVER add, update, or remove production data in Supabase.** No INSERT /
UPDATE / DELETE / UPSERT / TRUNCATE against the production database by any
route — SQL editor, `supabase` CLI, `psql`, PostgREST / service-role key,
admin endpoints, one-off scripts, anything.

Allowed: running releases (including the migrations workflow — schema changes
ride releases) and **read-only** production checks (statuses, logs,
dashboards, SELECTs). If a task seems to require touching prod data, stop and
ask John — do not do it as a side effect of something else.

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
1. Register URI handler for OAuth callbacks
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

`hello` goes out once per connect. `shell` and `capabilities` are new in 0.2.3.

- **`shell`** (`gitbash` | `cmd` | `pwsh` | `posix`) is diagnostic — the backend
  logs it, and `cmd` is a red flag there because everything it relays is POSIX.
- **`capabilities`** (`EXTENSION_CAPABILITIES` in `wsClient.ts`) is how the
  backend picks a route an older extension wouldn't understand; it treats a
  missing list as "none" and keeps the old behaviour. **A name here is a
  promise** — only add one when the behaviour it names is correct on every
  platform. `native_file_patch` says `read_file`/`write_file` resolve paths
  correctly on Windows too, which is what lets the backend patch app.json
  through them instead of relaying `node -e '<js>'` into a shell that may not
  be POSIX.

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
