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
1. The signed-in dashboard calls `POST /auth/vscode/handoff` and opens `vscode://mosayic.vscode-mosayic/handoff?code=…&email=…&api=…` (one-time code, 60 s; the email is REQUIRED since 0.2.18 — a link without one is refused, because otherwise a code someone minted for their own account read "connect as your Mosayic account" and the session was never checked against anything; `api` is the backend the dashboard talks to — the one that minted the code)
2. `UriEventHandler` routes `/handoff` to the command; VS Code offers to install the extension first if it's missing and replays the URI
3. If `api` names a different backend than `getApiUrl()` (compared with `sameBackend`, which folds localhost onto 127.0.0.1): when it is Production or Development the modal offers **Switch and connect** (clears the session, `setEnvironment`, then exchanges); any other host is refused by name — a crafted link can't point the extension at an arbitrary server. Otherwise, already signed in as that email → just reconnect. Otherwise a **modal confirm** names the account and where the request came from (login-CSRF guard: anyone can craft a `vscode://` link)
4. `POST /auth/vscode/exchange` with the code → the extension's own session (its own refresh chain, never the browser's); refused if the minted session's email ≠ the hint
5. Stored like a classic sign-in (replacing any previous session); any failure offers the classic "Mosayic: Sign In"

**Token refresh** (`authProvider.ts:83-128`):
- Triggered when WebSocket gets a 403
- POST to `{apiUrl}/auth/vscode/refresh` with refresh token
- On failure: signs user out and prompts re-login

**Session**: Single account only (`supportsMultipleAccounts: false`).

## WebSocket Communication

**Connection** (`src/ws/wsClient.ts`):
- URL: `ws[s]://{apiUrl}/ws` (from `getApiUrl()`: `mosayic.environment` → prod / dev constant, or `mosayic.apiUrl` when `custom`)
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
  understood and `hello` carries `home`. `toolchain` (0.2.13) says the
  extension can acquire missing CLI tools itself — download, verify, unpack,
  place, PATH — so the dashboard offers a button instead of a download link.
  `claude_limits` (0.2.17) says `claude_run` honours an allowlist and limits
  and reports refusals (see the Claude bridge below).

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
| `claude_run` `{prompt, path, session_id?, resume?, fork?}` | `claude -p <prompt> --permission-mode acceptEdits --output-format stream-json --verbose` in `path` (allowed-roots checked), progress distilled to human lines. **Sessions** (0.2.10, capability `claude_sessions`): `session_id` names a NEW session so the caller can resume it later without parsing the stream; `resume` continues one (what it read and wrote is still in context, prompt cache warm); `fork` (with `resume`) branches instead of extending — a fork inherits the parent, gets its OWN id, and does not pollute the parent, so sibling runs share an ancestor's exploration without inheriting each other. The two are mutually exclusive: resuming defines the id. A run is killed at `HEADLESS_RUN_TIMEOUT_MS` (30 min since 0.2.9) | `claude_output` `{text}` per line, then `claude_run_result` `{exit_code, result_text, error, session_id, duration_ms, num_turns, input_tokens, output_tokens, cache_read_tokens}` — the metrics come off Claude's own `result` event, which used to be read only for errors, so a successful forty-second run and an eight-minute one were indistinguishable afterwards. `session_id` is read from the stream, never assumed: a forked run's id is one the caller never chose, and it is the id a repair run has to resume |
| `claude_cancel` | Kills an in-flight run | — |

None of it goes through the command consent filter: binary and flags are
fixed here, the prompt is one argv entry (no shell), so the backend cannot
turn a prompt into a shell command. Claude Code's own permission rules still
apply — headless, anything but an edit is denied (Claude Code also approves a
few harmless read-only commands like `uname` or `wc` by itself).

**Limits, refusals and Stop (0.2.17, capability `claude_limits`).**
`claude_run` also takes `allowed_tools` (Claude Code tool rules, e.g.
`Bash(git status *)` → `--allowedTools`, for that run only), `max_turns`
(`--max-turns`, accepted though the CLI's help hides it), `max_budget_usd`
(`--max-budget-usd`, Claude's own cost estimate, which it keeps on a
subscription too), `timeout_s` (a shorter wall-clock kill than the thirty
minutes) and `append_system_prompt`. `sanitizeLimits` checks and clamps every
one (a rule must look like `Name` or `Name(pattern)`, ≤ 40 rules; turns 1–500,
budget $0.05–50, timeout 60 s–30 min, prompt ≤ 4000 chars), so the backend can
only make a run tighter. The backend owns WHICH rules (mosayic-api
`services/claude_profiles.py`, picked by name). A refusal is found two ways:
the tool's result is an error opening "This command requires approval" /
"Claude requested permissions to use", and the result event's
`permission_denials` (deduped by tool-use id). Each is sent as a `claude_output`
whose `text` reads on its own ("Not allowed from here: `npm install`") plus
`denial: {tool, command}`; the result carries `denials`, `stop_reason`
(`error_max_turns` → `max_turns`, `error_max_budget_usd` → `budget`, our
wall clock → `timeout`, a cancel → `cancelled`) and `cost_usd`. A Bash `$`
line is sent once the command has RUN, never on the request. **Kills take the
whole tree**: the PATH fallback runs `claude` through a shell, so the run is
spawned `detached` (its own process group) and `killTree` signals the group
(`taskkill /T /F` on Windows); before 0.2.17 a Stop or a timeout killed only
the shell and Claude finished the job underneath. stdin is `ignore`, or
`claude -p` waits 3 s for it on every run. A `resume` Claude doesn't know
("No conversation found…") is restarted cold once in `wsClient._claudeRun`.
The parser copies `session_id` / `resume` / `fork` across since 0.2.17; from
0.2.10 to 0.2.16 it dropped them and every run was cold.

**Claude's studio knowledge (0.2.22, capability `claude_knowledge`, `src/knowledge.ts`).**
A `claude_run` may carry `knowledge_url` (mosayic-api sets it when the studio
sends `knowledge: true`: the studio's own `/claude-knowledge.json`, built by
app.kealy.studio's `scripts/claudeKnowledge.ts` from its `knowledge/` docs and
the course). `acceptableKnowledgeUrl` takes https, or http on localhost only.
Before the run, `ensureKnowledge` does a conditional GET (ETag, 5 s timeout),
validates the pack (`format` 1, hex `version`, ≤ 400 `.md` files under plain
path segments, ≤ 6 MB, a `SKILL.md`) and writes it into
`<globalStorage>/claude-knowledge/<version>/` as a plugin: the manifest
`.claude-plugin/plugin.json` is written HERE and every file goes under
`skills/kealy-studio/`, so a pack can never add hooks, MCP servers, agents or
commands. The previous version is kept (a run may still be reading it), older
ones pruned. Offline or refused → the last good copy; none → the run goes
ahead without it. The run then gets `--plugin-dir <folder>`, read-only
`Read`/`Grep`/`Glob` rules for that folder (`knowledgeToolRules`: `//` +
POSIX path; Windows `C:\…` → `//c/…`, unverified on a real Windows machine;
without them a headless Read outside the run's folder is refused, verified
2026-11-06), and `KNOWLEDGE_PROMPT` appended to its system prompt. Never the
student's project, never `~/.claude` (John, 2026-11-06): Claude outside the
studio knows nothing of it. A Stop that arrives during the fetch is honoured
(the run never starts, `stop_reason: cancelled`). `claude_open` (the panel in
VS Code) can't take a plugin dir, so interactive Claude doesn't get it.

**The status bar's Claude item** (`extension.ts`, `wsClient.onClaudeRunsChange`):
"$(loading~spin) Claude is working on <folder> · Stop" while any run is in
flight; clicking runs `vscode-mosayic.stopClaudeRuns` (a modal confirm, then
`stopAllClaudeRuns`). It is the Stop that still works when the backend has
forgotten the run (an API restart) — the result goes up with
`stop_reason: cancelled`, which the backend doesn't alert.

**Testing a run outside VS Code**: `claude.ts` imports `vscode` only for the
binary lookup and the panel, so bundling it with esbuild and
`--alias:vscode=<a stub module>` gives a node harness that drives
`runClaudeHeadless` against the real CLI (the PATH fallback path). Run it
with `env -i HOME=$HOME PATH=$PATH …`: inside a Claude Code session the
`CLAUDE_CODE_*` variables make the child pass its permission questions up to
the parent session, so commands get approved that a student's run refuses.

**The toolchain bridge** (`src/toolchain.ts`, 0.2.13, capability `toolchain`).
Installing the CLI tools a student is missing, instead of linking them to a
download page. The backend decides *how* (`app/data/toolchain.py` +
`app/services/toolchain.py`: reuse what's there → drive an nvm/brew/winget/
scoop they already have → the official archive, resolved for platform AND
arch, with the publisher's sha256); this side does it and reports progress.
Everything is per-user — no admin rights, no password, on any platform.

| Incoming | Does | Reply |
|----------|------|-------|
| `toolchain_probe` `{tools:[{key,command,binary}], managers:[{name,command}]}` | Runs the backend's own probe commands (so this can't disagree with `/system/probe-tools`) plus a `--version` per package manager. Provenance comes from our manifest: a tool inside a directory we installed is `mosayic`, anything else is `theirs` | `tools:[{key, installed, version, path, provenance}]`, `managers:[…]` |
| `toolchain_install` `{plan}` | One rung, chosen by the backend. `archive`: download (https, redirects, progress) → **sha256 verify** → unpack (`tar`; `tar.exe` on Windows, which reads zips too, with `Expand-Archive` as fallback; PortableGit's 7-Zip SFX via `-o… -y`) → place → PATH → verify. `manager` / `npm`: run the line, then verify. `command`: fire a GUI installer (macOS git = `xcode-select --install`) and **poll the probe**, because the process exit means nothing and the student may have hit Cancel | `toolchain_output` `{text, percent?, phase?}` per step, then `toolchain_install_result` `{status, version, path, error}` |
| `toolchain_remove` `{key}` | Deletes a tool from the manifest and rewrites PATH. Refuses anything that isn't ours | `status` removed / not_managed / error |

**Placement** is the tool's own conventional per-user home where it has one —
Windows git goes to `%LOCALAPPDATA%\Programs\Git`, which `shell.ts` already
searches, so installing git also retires the cmd.exe fallback that can't parse
anything the backend relays. Everything else lives under `~/.mosayic/tools`
with a manifest recording version, source URL and directory, which is what
makes `toolchain_remove` and the dashboard's Machine page honest.

**PATH** is a marked, reversible block in `~/.zshrc` + `~/.bash_profile`, or
the HKCU user Path via .NET's `SetEnvironmentVariable` on Windows — **never
`setx`**, which truncates PATH at 1024 characters. And because a profile is
only read by a NEW shell, `toolchainEnv()` prepends the managed directories at
every spawn site (relayed commands, terminals, dev servers, Claude runs, the
Docker probe) so a tool installed one step ago works in the next one.

**Windows' live PATH** (0.2.20, `registryPathDirs` in `toolchain.ts`): a
Windows process keeps the PATH it started with, so anything installed by its
own installer while VS Code was open (Docker Desktop, gcloud, gh's .msi, Git,
nvm-windows) was invisible until every VS Code window was quit.
`toolchainEnv()` now also reads the machine + user `Path` from the registry
(`reg query`, `%VAR%` expanded, cached 30 s) and APPENDS what's new, compared
case-insensitively, so the student's order wins; ours still go first.

**Mosayic's terminals are Git Bash on Windows** (0.2.19, `terminalShellOptions`
in `shell.ts`; since 0.2.20 through `mosayicTerminalOptions` in
`toolchain.ts`, which also gives them `toolchainEnv`'s PATH). Every
`createTerminal` that types a backend command (`wsClient._runInTerminal`,
`claude.ts`'s terminal fallback) spreads it in:
`shellPath` = Git Bash, `--login -i`, `CHERE_INVOKING=1` (stay in the
terminal's cwd). Without it they opened in the default profile, PowerShell,
which can't run the POSIX one-liners the backend sends. The student's
`terminal.integrated.defaultProfile.windows` is deliberately NOT touched
(John: their own terminals are theirs). It follows `mosayic.windowsShell` like
relayed commands do. Every `claude` spawn gets `CLAUDE_CODE_GIT_BASH_PATH`
(`claudeEnv` in `claude.ts`) unless the student set one. Not yet run on a
real Windows machine.

## Workspace Trust and folder switches (0.2.21)

`package.json` declares `capabilities.untrustedWorkspaces: limited`. Without
it VS Code DISABLES the extension in Restricted Mode, so the first time
Mosayic opened a never-seen project folder the trust question took the
connection down and the studio just waited. `mosayic.environment`, `apiUrl`,
`confirmCommands` and `windowsShell` are `restrictedConfigurations`: an
untrusted folder's own settings can't redirect the backend or loosen
consent. `_openFolder` skips a folder that's already open and runs
`workspace.saveAll(false)` first, so switching doesn't stop on "Save
changes?" (untitled tabs can still ask).

**"VS Code needs you"** (capability `attention`, 0.2.21): whatever waits on
the person here is sent as `{type:'attention', id, reason, detail}` and taken
back with `{type:'attention_clear', id}` — the consent toast (`consent:<n>`),
the folder picker (`pick_folder:<n>`), and the trust question
(`workspace_trust`, while `!workspace.isTrusted`, cleared on
`onDidGrantWorkspaceTrust`). The open set is resent on every connect. The
`/focus` URI opens `workbench.trust.manage` while trust is pending.

## 0.2.24 (2026-11-08): the student's Supabase grant lives HERE

Capability **`supabase_client`**, `src/supabase.ts`. Until this day the
backend held every student's Supabase OAuth tokens and generated database
passwords, and drove Supabase's Management API itself (John: never what he
meant to be holding). Now the consent is the same one click, but the minted
pair comes to this extension (`supabase_tokens`) and lives in VS Code's
secret storage (the OS keychain, like gh's token); the backend keeps nothing
and renews a pair on request (`POST /supabase-oauth/refresh`, with the
extension's own Mosayic session; a 400/401/403/409 there drops the pair:
"connect again"). Messages, each answered by `<type>_result`:

| Incoming | Does |
|----------|------|
| `supabase_tokens` `{access_token, refresh_token, expires_at}` | store |
| `supabase_forget` | delete; the refresh token goes back so the backend can revoke it |
| `supabase_status` | `{connected, organization_slug, organization_name}` (a live `/v1/organizations`) |
| `supabase_api` `{method, path, body?, env_secrets?}` | ONE of the **`ALLOWED`** paths (orgs, projects, a project, `config/auth` GET/PATCH); anything else is refused by name — in particular `/database/query`: this code can't run SQL on a student's live database even if told to. `env_secrets` names payload fields to fill from a file on this machine (the Google client secret from `<api>/supabase/.env`). Auth-config reads come back with secret fields as `<set>`. |
| `supabase_provision` `{name, organization_slug, region}` | generate the password → `POST /v1/projects` → keep the password in secret storage under the ref until `supabase_finalize` has put it in GitHub |
| `supabase_finalize` `{ref, api_path?, gcloud_project_id?, want_*}` | once `ACTIVE_HEALTHY`: the keys (publishable key + URL go back; the **secret key is piped into `gcloud secrets create` / `versions add` on stdin and never returned**), the pooler config → `DATABASE_CONNECTION_STRING` via `gh secret set` on stdin in `api_path` (then the held password is deleted) |
| `supabase_db_secret` `{ref, api_path, password?}` | the GitHub secret from a password given now (link / after a dashboard reset) or the held one; nothing kept |

Secret values ride **stdin** (`runWithInput`, Mosayic's shell + PATH), never
a command line. Nothing here is logged beyond "stored" / "forgotten" /
"created <ref>". `extension.ts` gives `wsClient.supabase` the context's
`SecretStorage`. Not yet run against a real Supabase account: John runs the
first create on his own.

## 0.2.23 (2026-11-08, John's Windows test)

- **One Claude Code install at a time** (`wsClient._claudeInstalling`). VS
  Code's install waits on 'Do you trust the publisher "Anthropic"?', which
  can sit behind the browser; the backend gave up after 120 s, the student
  clicked again, and every request queued another trust dialog. A request
  while one runs now waits for it. After 1.5 s the install raises attention
  `claude_install` (the studio's "VS Code needs you" banner: click Trust
  Publisher & Install). The trust question can't be skipped from an
  extension (VS Code 1.145's `installExtension` sets no
  `skipPublisherTrust`).
- **`verify()` re-reads the registry PATH first.** winget's node said
  "Path environment variable modified … Successfully installed", but the
  30 s `registryPathCache` hid it, so a good install was reported failed.

## Command Execution

When a `command` message arrives (`wsClient.ts:153-217`):

1. **User consent** (if `mosayic.confirmCommands` is true — the default):
   - Shows warning dialog with redacted command
   - Options: "Allow", "Allow All" (disables future prompts), "Deny"
2. **Spawns shell process** in the first workspace folder
3. **Streams stdout** back as `command_output` messages
4. **Sends final result** as `command_result` with stdout, stderr, exit_code
5. **Limits**: 600s timeout (`COMMAND_TIMEOUT_MS`; the API's per-command `timeout` is NOT forwarded — the extension's constant wins), 10 MB max output buffer per stream

**The allowlist** (`ALLOWED_FIRST_TOKENS` in `src/config.ts`) grew `xcrun`
and `open` on 2026-10-06 for the dashboard's store-screenshots card, which
drives the iPhone Simulator (`xcrun simctl list/boot/install/status_bar/
openurl/io screenshot`, `open -a Simulator`). Until a student is on that
build the dashboard sends them as `cd "<mobile folder>" && xcrun …`, which
the first-token rule already accepts.

**Security features**:
- Credential redaction in logs (passwords, tokens, keys, Bearer headers)
- Plaintext HTTP warning for remote (non-localhost) connections
- User consent prompt before execution (default on)

## Registered Commands

| Command ID | Label | Description |
|------------|-------|-------------|
| `vscode-mosayic.signIn` | Sign in to Mosayic | Opens browser for OAuth login (2-min timeout) |
| `vscode-mosayic.signOut` | Sign out of Mosayic | Clears session, disconnects WebSocket |
| `vscode-mosayic.stopClaudeRuns` | Mosayic: Stop Claude | Stops every headless Claude run (the status bar's Claude item; 0.2.17) |

## Configuration Settings

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `mosayic.environment` | `prod` \| `dev` \| `custom` | `prod` | Which backend: `https://mosayic-api.fly.dev`, `http://127.0.0.1:8090`, or `mosayic.apiUrl`. Global — survives updates and repo switches. |
| `mosayic.apiUrl` | string | `""` | The `custom` backend URL; empty falls back to production (the old default was the dead Cloud Run host) |
| `mosayic.confirmCommands` | `allowlisted` \| `always` \| `never` | `allowlisted` | When to prompt before running a relayed command |
| `mosayic.showDevCommands` | boolean | `false` | Show `Mosayic: Switch Backend…` in the palette |

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
