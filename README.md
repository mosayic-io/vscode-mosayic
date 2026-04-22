# Mosayic for VS Code

The official VS Code extension for [Mosayic](https://app.mosayic.io) — a SaaS platform for guided mobile app development.

This extension is the bridge between the Mosayic web dashboard and your local machine. The dashboard tells you what to do; the extension does it for you, on your hardware, with your tools.

## What it does

- **Signs you in** to Mosayic using your Google account, via a secure OAuth flow.
- **Connects to the Mosayic backend** over a persistent WebSocket.
- **Executes commands** sent from the dashboard (`gh`, `gcloud`, `expo`, `supabase`, etc.) inside your current VS Code workspace.
- **Streams output** back to the dashboard in real time.

Your credentials stay yours: tokens are stored in your OS keychain and secrets are redacted from logs.

## Getting started

1. Install the extension from the VS Code Marketplace.
2. Open a folder in VS Code — this becomes the working directory for executed commands.
3. Run **Mosayic: Sign In** from the command palette (`Ctrl/Cmd+Shift+P`).
4. Complete the Google sign-in in your browser.
5. Head to [app.mosayic.io](https://app.mosayic.io) — your VS Code instance is now connected.

## Commands

| Command | What it does |
|---------|--------------|
| `Mosayic: Sign In` | Opens browser for Google OAuth login. |
| `Mosayic: Sign Out` | Clears your session and disconnects. |
| `Mosayic: Show Logs` | Opens the extension's output channel. |
| `Mosayic: Reset Command Prompts` | Re-enables the per-command consent prompt. |

## Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `mosayic.confirmCommands` | `allowlisted` | When to prompt before running commands: `allowlisted` (auto-approve known Mosayic CLIs), `always`, or `never`. |

## Security

- Tokens are stored in VS Code's `secretStorage` (your OS-level credential manager).
- Commands containing secrets (passwords, tokens, Bearer headers) are redacted in the log output.
- Plaintext HTTP connections to non-localhost servers trigger a warning.
- By default, commands from outside the Mosayic CLI allowlist require your explicit approval before they run.

## Requirements

- VS Code 1.96.0 or newer.
- An open workspace folder (commands execute relative to it).
- A Mosayic account ([sign up here](https://app.mosayic.io)).

## Issues & feedback

Bug reports and feature requests: https://github.com/mosayic-io/vscode-mosayic/issues
