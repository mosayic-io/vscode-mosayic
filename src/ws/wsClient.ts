import * as vscode from 'vscode';
import { spawn } from 'child_process';
import { existsSync, realpathSync, statSync } from 'fs';
import { homedir } from 'os';
import { WebSocket } from 'ws';
import {
	getApiUrl,
	isInsecureRemoteUrl,
	getConfirmMode,
	isAllowlistedCommand,
} from '../config';
import { TerminalRegistry } from './managedTerminal';

const RECONNECT_DELAYS = [1000, 2000, 5000, 10000, 30000];
const PING_INTERVAL = 30000;
const MAX_RECONNECT_ATTEMPTS = 10;
const MAX_OUTPUT_BYTES = 10 * 1024 * 1024; // 10 MB
const COMMAND_TIMEOUT_MS = 600_000;

export type WsState =
	| 'signed-out'
	| 'idle'
	| 'connecting'
	| 'connected'
	| 'reconnecting'
	| 'auth-error'
	| 'error';

// Discriminated union of every message the backend sends us. Keeping this
// here (rather than on a loose object) means the dispatcher below gets
// exhaustive-checking.
type IncomingMessage =
	| { type: 'command'; request_id: string; command: string }
	| { type: 'terminal_command'; request_id: string; command: string; name?: string }
	| { type: 'pick_folder'; request_id: string; title?: string; return_url?: string }
	| { type: 'open_folder'; request_id: string; path: string; notice?: 'scaffold_complete' }
	| { type: 'send_to_terminal'; name: string; text: string }
	| { type: 'start_dev_server'; request_id: string; session_id: string; command: string; name?: string; path?: string }
	| { type: 'stop_dev_server'; request_id: string; session_id: string }
	| { type: 'terminal_input'; session_id: string; text: string }
	| { type: 'dev_server_status'; request_id: string; session_id: string };

function isString(v: unknown): v is string {
	return typeof v === 'string' && v.length > 0;
}

function parseIncoming(raw: unknown): IncomingMessage | undefined {
	if (raw === null || typeof raw !== 'object') { return undefined; }
	const m = raw as Record<string, unknown>;
	const type = m.type;
	if (!isString(type)) { return undefined; }
	switch (type) {
		case 'command':
			if (isString(m.request_id) && isString(m.command)) {
				return { type, request_id: m.request_id, command: m.command };
			}
			return undefined;
		case 'terminal_command':
			if (isString(m.request_id) && isString(m.command)) {
				return { type, request_id: m.request_id, command: m.command, name: isString(m.name) ? m.name : undefined };
			}
			return undefined;
		case 'pick_folder':
			if (isString(m.request_id)) {
				return {
					type,
					request_id: m.request_id,
					title: isString(m.title) ? m.title : undefined,
					return_url: isString(m.return_url) ? m.return_url : undefined,
				};
			}
			return undefined;
		case 'open_folder':
			if (isString(m.request_id) && isString(m.path)) {
				const notice = m.notice === 'scaffold_complete' ? 'scaffold_complete' : undefined;
				return { type, request_id: m.request_id, path: m.path, notice };
			}
			return undefined;
		case 'send_to_terminal':
			if (isString(m.name) && isString(m.text)) {
				return { type, name: m.name, text: m.text };
			}
			return undefined;
		case 'start_dev_server':
			if (isString(m.request_id) && isString(m.session_id) && isString(m.command)) {
				return {
					type,
					request_id: m.request_id,
					session_id: m.session_id,
					command: m.command,
					name: isString(m.name) ? m.name : undefined,
					path: isString(m.path) ? m.path : undefined,
				};
			}
			return undefined;
		case 'stop_dev_server':
			if (isString(m.request_id) && isString(m.session_id)) {
				return { type, request_id: m.request_id, session_id: m.session_id };
			}
			return undefined;
		case 'terminal_input':
			if (isString(m.session_id) && isString(m.text)) {
				return { type, session_id: m.session_id, text: m.text };
			}
			return undefined;
		case 'dev_server_status':
			if (isString(m.request_id) && isString(m.session_id)) {
				return { type, request_id: m.request_id, session_id: m.session_id };
			}
			return undefined;
		default:
			return undefined;
	}
}

/**
 * Validate and resolve a folder path received from the backend.
 *
 * - Must exist and be a directory.
 * - After resolving symlinks, must live under either the user's home directory
 *   or the active workspace folder. This prevents a compromised / buggy backend
 *   from pointing VS Code at /etc, /proc, or an attacker-writable directory.
 *
 * Returns the absolute, symlink-resolved path on success, or undefined with a
 * human-readable reason.
 */
function resolveFolderPath(folderPath: string): { path: string } | { error: string } {
	if (!folderPath || folderPath.includes('\0')) {
		return { error: 'Empty or malformed path' };
	}
	if (!existsSync(folderPath)) {
		return { error: 'Path does not exist' };
	}
	let real: string;
	try {
		real = realpathSync(folderPath);
	} catch (e) {
		return { error: `Cannot resolve path: ${e instanceof Error ? e.message : String(e)}` };
	}
	let stat;
	try {
		stat = statSync(real);
	} catch (e) {
		return { error: `Cannot stat path: ${e instanceof Error ? e.message : String(e)}` };
	}
	if (!stat.isDirectory()) {
		return { error: 'Path is not a directory' };
	}
	const home = realpathSync(homedir());
	const workspace = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	const allowedRoots = [home];
	if (workspace) {
		try {
			allowedRoots.push(realpathSync(workspace));
		} catch {
			// ignore — if the workspace root is unreadable, we still have home
		}
	}
	const withSep = (p: string) => (p.endsWith('/') ? p : p + '/');
	const underAllowed = allowedRoots.some(root => real === root || real.startsWith(withSep(root)));
	if (!underAllowed) {
		return { error: 'Path is outside allowed directories (must be under $HOME or workspace root)' };
	}
	return { path: real };
}

export class MosayicWebSocketClient implements vscode.Disposable {
	private _ws: WebSocket | undefined;
	private _disposed = false;
	private _reconnectAttempt = 0;
	private _reconnectTimer: ReturnType<typeof setTimeout> | undefined;
	private _pingTimer: ReturnType<typeof setInterval> | undefined;
	private _getToken: () => Promise<string | undefined>;
	private _refreshToken: (() => Promise<boolean>) | undefined;
	private _outputChannel: vscode.OutputChannel;
	private _terminalRegistry = new TerminalRegistry();
	private _state: WsState = 'idle';
	private _onStateChange: ((state: WsState, detail?: string) => void) | undefined;
	// Set by the 'error' handler when an HTTP 403 is detected during the
	// WebSocket upgrade. The ws library guarantees 'error' fires before
	// 'close', so the 'close' handler reads this flag safely.
	private _upgradeRejected = false;
	// Guards _handleAuthFailure so overlapping 403s don't trigger concurrent
	// refresh storms.
	private _refreshInFlight = false;
	// Session-scoped "allow all" choice. Re-enabled on sign-out or extension
	// reload, and via the ``Mosayic: Reset Command Prompts`` command.
	private _sessionAllowAll = false;
	// Terminal-closed listeners we still owe a dispose call. Without this the
	// subscription leaks if the WS client is torn down before the terminal
	// closes.
	private _activeTerminalListeners: vscode.Disposable[] = [];
	// Dispatch table for incoming messages. Populated in the constructor so
	// ``this`` is bound correctly.
	private _handlers: {
		[K in IncomingMessage['type']]: (m: Extract<IncomingMessage, { type: K }>) => void;
	};

	// Called just before openFolder reloads the workspace, when the backend
	// flagged the open as the end of a scaffold. Lets the host extension
	// persist a "show this on next activation" marker that survives the
	// reload.
	private _onScaffoldComplete: ((path: string) => void) | undefined;
	// Most recent terminal name created via terminal_command. Used by the
	// /focus URI handler to land the user on the right terminal after the
	// dashboard's "open VS Code" deep link brings the window to the front.
	private _lastTerminalName: string | undefined;

	constructor(
		getToken: () => Promise<string | undefined>,
		refreshToken?: () => Promise<boolean>,
		onScaffoldComplete?: (path: string) => void,
	) {
		this._getToken = getToken;
		this._refreshToken = refreshToken;
		this._onScaffoldComplete = onScaffoldComplete;
		this._outputChannel = vscode.window.createOutputChannel('Mosayic WebSocket');
		this._handlers = {
			command: (m) => void this._executeCommand(m.request_id, m.command),
			terminal_command: (m) => void this._runInTerminal(m.request_id, m.command, m.name),
			pick_folder: (m) => void this._pickFolder(m.request_id, m.title, m.return_url),
			open_folder: (m) => void this._openFolder(m.request_id, m.path, m.notice),
			send_to_terminal: (m) => this._sendToTerminal(m.name, m.text),
			start_dev_server: (m) => this._startDevServer(m.request_id, m.session_id, m.command, m.name, m.path),
			stop_dev_server: (m) => this._stopDevServer(m.request_id, m.session_id),
			terminal_input: (m) => this._terminalInput(m.session_id, m.text),
			dev_server_status: (m) => this._devServerStatus(m.request_id, m.session_id),
		};
	}

	get state(): WsState {
		return this._state;
	}

	get outputChannel(): vscode.OutputChannel {
		return this._outputChannel;
	}

	onStateChange(cb: (state: WsState, detail?: string) => void): void {
		this._onStateChange = cb;
		// Emit current state so the listener syncs immediately
		cb(this._state);
	}

	resetCommandPrompts(): void {
		this._sessionAllowAll = false;
		this._log('Command prompts re-enabled for this session.');
	}

	/**
	 * Bring the most recent Mosayic terminal to the front. Called by the
	 * "/focus" URI handler after the dashboard hands off to a terminal flow
	 * (e.g. "Create iPhone development build") so the user lands on the
	 * running terminal instead of whatever VS Code happened to be showing.
	 *
	 * The OS-level focus shift is already handled by VS Code receiving the
	 * URI; this just picks the right terminal inside the window.
	 */
	focusLastTerminal(): void {
		const target = this._lastTerminalName
			? vscode.window.terminals.find(t => t.name === this._lastTerminalName)
			: undefined;
		const fallback = target ?? vscode.window.terminals.find(t => t.name.startsWith('Mosayic'));
		if (fallback) {
			fallback.show(false);
			this._log(`Focused terminal "${fallback.name}"`);
		} else {
			this._log('No Mosayic terminal to focus.');
		}
	}

	/**
	 * Force a fresh connection attempt. Resets the reconnect counter so a
	 * client that had given up after MAX_RECONNECT_ATTEMPTS gets fresh tries.
	 * Used by the "wake" URI handler when the user clicks the dashboard's
	 * "Open VS Code" button.
	 */
	async forceReconnect(): Promise<void> {
		this._reconnectAttempt = 0;
		if (this._reconnectTimer) {
			clearTimeout(this._reconnectTimer);
			this._reconnectTimer = undefined;
		}
		this._logConn('Wake-up requested — forcing fresh connection attempt.');
		await this.connect();
	}

	private _setState(state: WsState, detail?: string): void {
		if (this._state === state) { return; }
		this._state = state;
		this._log(`state → ${state}${detail ? ` (${detail})` : ''}`);
		this._onStateChange?.(state, detail);
	}

	async connect(): Promise<void> {
		if (this._disposed) {
			return;
		}

		this._cleanup();
		this._upgradeRejected = false;

		const token = await this._getToken();
		if (!token) {
			this._logAuth('Not signed in — no access token. Skipping WebSocket connection. Run "Mosayic: Sign In" to authenticate.');
			this._setState('signed-out');
			return;
		}

		const apiUrl = getApiUrl();

		if (isInsecureRemoteUrl(apiUrl)) {
			// Hard-block plaintext HTTP to a remote host. Bearer token and every
			// subsequent command would travel unencrypted.
			this._logConn(
				`ERROR: refusing to connect. mosayic.apiUrl is a remote plaintext URL (${apiUrl}). ` +
				`Use https:// (WSS) or switch to a localhost URL.`,
			);
			this._setState('error', 'insecure remote URL rejected');
			void vscode.window.showErrorMessage(
				`Mosayic refuses to send tokens over plaintext HTTP to a remote host. ` +
				`Change "mosayic.apiUrl" to an https:// URL or a localhost address.`,
			);
			return;
		}

		const wsUrl = apiUrl.replace(/^http/, 'ws') + '/ws';

		this._logConn(`Dialing ${wsUrl}`);
		this._setState('connecting', apiUrl);

		const ws = new WebSocket(wsUrl, {
			headers: {
				'Authorization': `Bearer ${token}`,
			},
		});
		this._ws = ws;

		ws.on('open', () => {
			this._logConn(`Connected to ${apiUrl}/ws`);
			this._reconnectAttempt = 0;
			this._startPing();
			this._setState('connected', apiUrl);
		});

		ws.on('message', (raw: Buffer) => {
			let parsed: unknown;
			try {
				parsed = JSON.parse(raw.toString());
			} catch {
				this._log(`Discarded non-JSON message (${raw.length} bytes)`);
				return;
			}
			const message = parseIncoming(parsed);
			if (!message) {
				const preview = typeof parsed === 'object' && parsed !== null
					? `type=${(parsed as Record<string, unknown>).type ?? '?'}`
					: `typeof=${typeof parsed}`;
				this._log(`Discarded malformed message (${preview})`);
				return;
			}
			this._dispatch(message);
		});

		ws.on('close', (code: number, reason: Buffer) => {
			this._stopPing();

			if (this._upgradeRejected || code === 4003) {
				this._logAuth(`Server closed WebSocket with auth code ${code}. Token is missing, expired, or rejected.`);
				this._setState('auth-error', `code=${code}`);
				void this._handleAuthFailure();
				return;
			}

			this._logConn(`WebSocket closed (code=${code}, reason=${reason.toString() || 'none'})`);
			if (!this._disposed) {
				this._scheduleReconnect();
			}
		});

		ws.on('error', (err: Error) => {
			if (err.message.includes('403')) {
				this._upgradeRejected = true;
				this._logAuth('Server returned HTTP 403 during WebSocket upgrade — token is expired or invalid.');
			} else if (/ECONNREFUSED|ENOTFOUND|ETIMEDOUT|ECONNRESET/.test(err.message)) {
				this._logConn(`Cannot reach API: ${err.message}. Is the server running at ${apiUrl}?`);
				this._setState('error', err.message);
			} else {
				this._logConn(`Unexpected WebSocket error: ${err.message}`);
				this._setState('error', err.message);
			}
		});
	}

	disconnect(): void {
		this._cleanup();
		// Signing out should re-arm the consent prompts so a later user isn't
		// left running under a previous session's "Allow All".
		this._sessionAllowAll = false;
		this._logAuth('Disconnected by client (signed out or extension shutting down)');
		this._setState('signed-out');
	}

	private async _handleAuthFailure(): Promise<void> {
		if (this._refreshInFlight) {
			this._logAuth('Token refresh already in flight — skipping duplicate attempt.');
			return;
		}
		this._refreshInFlight = true;
		try {
			if (!this._refreshToken) {
				this._logAuth('No refresh token handler available — sign in again to reconnect.');
				this._promptSignIn();
				return;
			}

			this._logAuth('Attempting token refresh…');
			let refreshed = await this._refreshToken();

			if (!refreshed && !this._disposed) {
				this._logAuth('First refresh attempt failed, retrying in 2s…');
				await new Promise((r) => setTimeout(r, 2000));
				if (this._disposed) { return; }
				refreshed = await this._refreshToken();
			}

			if (this._disposed) { return; }

			if (refreshed) {
				this._logAuth('Token refreshed successfully — reconnecting.');
				this._reconnectAttempt = 0;
				if (this._reconnectTimer) {
					clearTimeout(this._reconnectTimer);
				}
				this._reconnectTimer = setTimeout(() => {
					this._reconnectTimer = undefined;
					if (!this._disposed) { void this.connect(); }
				}, 500);
			} else {
				this._logAuth('Token refresh failed — sign in again to reconnect.');
				this._promptSignIn();
			}
		} finally {
			this._refreshInFlight = false;
		}
	}

	private _promptSignIn(): void {
		void vscode.window.showWarningMessage(
			'Mosayic session expired. Sign in again to reconnect.',
			'Sign in',
		).then((choice) => {
			if (choice === 'Sign in') {
				void vscode.commands.executeCommand('vscode-mosayic.signIn');
			}
		});
	}

	private _dispatch(message: IncomingMessage): void {
		// Narrow via the message type and hand off to the per-type handler.
		const handler = this._handlers[message.type] as (m: IncomingMessage) => void;
		handler(message);
	}

	private async _consent(command: string, verb: 'run a command' | 'run in terminal'): Promise<'allow' | 'deny'> {
		const mode = getConfirmMode();
		if (mode === 'never') { return 'allow'; }
		if (this._sessionAllowAll) { return 'allow'; }
		if (mode === 'allowlisted' && isAllowlistedCommand(command)) { return 'allow'; }

		const redacted = this._redact(command);
		const choice = await vscode.window.showWarningMessage(
			`Mosayic server wants to ${verb}: ${redacted}`,
			{ modal: false },
			'Allow', 'Allow All (session)', 'Deny',
		);
		if (choice === 'Allow All (session)') {
			// Session-scoped — cleared on sign-out, reset command, or reload.
			this._sessionAllowAll = true;
			return 'allow';
		}
		return choice === 'Allow' ? 'allow' : 'deny';
	}

	private async _executeCommand(requestId: string, command: string): Promise<void> {
		try {
			const consent = await this._consent(command, 'run a command');
			if (consent !== 'allow') {
				const redacted = this._redact(command);
				this._log(`Command denied by user: ${redacted}`);
				this._sendResult(requestId, '', 'Command denied by user', 1);
				return;
			}

			// Node's spawn with shell:true returns ENOENT for /bin/sh if cwd
			// doesn't exist on disk — this happens when VS Code has a stale
			// workspace folder open whose path was deleted, or when the
			// workspace is a non-local URI (vscode-vfs, vscode-remote, etc.).
			// Validate before spawn so we fail with a useful message instead of
			// "spawn /bin/sh ENOENT", and so scaffold-style commands (which
			// start with cd or mkdir -p) can run even when the workspace cwd
			// is unusable.
			const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
			const workspacePath = workspaceFolder?.uri.scheme === 'file'
				? workspaceFolder.uri.fsPath
				: undefined;
			const home = homedir();
			let cwd = workspacePath || home;
			if (!existsSync(cwd)) {
				this._log(`  cwd ${cwd} does not exist — falling back to ${home}`);
				cwd = home;
			}
			if (!existsSync(cwd)) {
				this._log(`  homedir ${home} also does not exist — falling back to /`);
				cwd = '/';
			}
			this._log(`Executing: ${this._redact(command)} (cwd: ${cwd})`);

			const child = spawn(command, {
				shell: true,
				cwd,
				timeout: COMMAND_TIMEOUT_MS,
			});

			let stdout = '';
			let stderr = '';
			let resultSent = false;
			const safeSendResult = (exitCode: number) => {
				if (resultSent) { return; }
				resultSent = true;
				this._sendResult(requestId, stdout, stderr, exitCode);
			};

			if (child.stdout) {
				child.stdout.on('data', (chunk: Buffer) => {
					const text = chunk.toString();
					if (stdout.length < MAX_OUTPUT_BYTES) {
						stdout += text;
					}
					for (const line of text.trimEnd().split('\n')) {
						this._log(`  [stdout] ${line}`);
					}
					this._sendOutput(requestId, text);
				});
			}

			if (child.stderr) {
				child.stderr.on('data', (chunk: Buffer) => {
					const text = chunk.toString();
					if (stderr.length < MAX_OUTPUT_BYTES) {
						stderr += text;
					}
					for (const line of text.trimEnd().split('\n')) {
						this._log(`  [stderr] ${line}`);
					}
					this._sendOutput(requestId, text);
				});
			}

			child.on('close', (code: number | null) => {
				const exitCode = code ?? 1;
				this._log(`  Finished: exit_code=${exitCode}`);
				safeSendResult(exitCode);
			});

			child.on('error', (err: Error) => {
				this._log(`  Process error: ${err.message}`);
				stderr += err.message;
				safeSendResult(1);
			});
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			this._log(`  _executeCommand failed: ${msg}`);
			this._sendResult(requestId, '', msg, 1);
		}
	}

	private async _runInTerminal(requestId: string, command: string, name?: string): Promise<void> {
		try {
			const consent = await this._consent(command, 'run in terminal');
			if (consent !== 'allow') {
				const redacted = this._redact(command);
				this._log(`Terminal command denied by user: ${redacted}`);
				this._sendJson({ type: 'terminal_result', request_id: requestId, status: 'denied' });
				return;
			}

			const terminalName = name || 'Mosayic';
			const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
			const terminalCwd = workspaceFolder || homedir();
			this._log(`Opening terminal "${terminalName}": ${this._redact(command)} (cwd: ${terminalCwd})`);

			const terminal = vscode.window.createTerminal({
				name: terminalName,
				cwd: terminalCwd,
				iconPath: new vscode.ThemeIcon('rocket'),
			});
			terminal.show();
			terminal.sendText(command);
			// Remember which terminal the dashboard's "open VS Code" focus URI
			// should land the user on. We track by name because Terminal
			// instances become stale when closed.
			this._lastTerminalName = terminalName;

			this._sendJson({ type: 'terminal_result', request_id: requestId, status: 'opened' });

			// Register the close listener so we can dispose it on teardown.
			const listener = vscode.window.onDidCloseTerminal((closed) => {
				if (closed === terminal) {
					const idx = this._activeTerminalListeners.indexOf(listener);
					if (idx >= 0) { this._activeTerminalListeners.splice(idx, 1); }
					listener.dispose();
					this._log(`Terminal "${terminalName}" closed`);
					this._sendJson({ type: 'terminal_closed', request_id: requestId });
				}
			});
			this._activeTerminalListeners.push(listener);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			this._log(`_runInTerminal failed: ${msg}`);
			this._sendJson({ type: 'terminal_result', request_id: requestId, status: 'error', error: msg });
		}
	}

	private _sendToTerminal(name: string, text: string): void {
		const terminal = vscode.window.terminals.find(t => t.name === name);
		if (terminal) {
			terminal.sendText(text, false); // false = don't append newline
			this._log(`Sent input to terminal "${name}"`);
		} else {
			this._log(`Terminal "${name}" not found`);
		}
	}

	private async _openFolder(
		requestId: string,
		folderPath: string,
		notice?: 'scaffold_complete',
	): Promise<void> {
		try {
			const resolved = resolveFolderPath(folderPath);
			if ('error' in resolved) {
				this._log(`DENIED open_folder "${folderPath}": ${resolved.error}`);
				this._sendJson({
					type: 'open_folder_result',
					request_id: requestId,
					status: 'denied',
					error: resolved.error,
				});
				return;
			}
			this._log(`Opening folder: ${resolved.path}`);
			const uri = vscode.Uri.file(resolved.path);
			this._sendJson({ type: 'open_folder_result', request_id: requestId, status: 'opened' });
			// Persist the notice BEFORE the openFolder reload — once that
			// command runs the current extension host shuts down and any code
			// after it may not run.
			if (notice === 'scaffold_complete') {
				this._onScaffoldComplete?.(resolved.path);
			}
			// This reloads the window — the extension will reconnect after.
			await vscode.commands.executeCommand('vscode.openFolder', uri, { forceNewWindow: false });
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			this._log(`_openFolder failed: ${msg}`);
			this._sendJson({ type: 'open_folder_result', request_id: requestId, status: 'error', error: msg });
		}
	}

	private async _pickFolder(requestId: string, title?: string, returnUrl?: string): Promise<void> {
		try {
			this._log(`Folder picker requested: ${title ?? 'Select folder'}`);

			const uris = await vscode.window.showOpenDialog({
				canSelectFolders: true,
				canSelectFiles: false,
				canSelectMany: false,
				openLabel: title || 'Choose folder',
				title: title || 'Choose folder',
			});

			const path = uris?.[0]?.fsPath ?? null;
			this._log(path ? `Folder selected: ${path}` : 'Folder picker cancelled');
			this._sendJson({ type: 'pick_folder_result', request_id: requestId, path });

			// Hand focus back to the dashboard so the user isn't stranded in an
			// empty VS Code window while the guide continues in the browser.
			if (returnUrl) {
				this._refocusBrowser(returnUrl);
			}
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			this._log(`_pickFolder failed: ${msg}`);
			this._sendJson({ type: 'pick_folder_result', request_id: requestId, path: null, error: msg });
			if (returnUrl) {
				this._refocusBrowser(returnUrl);
			}
		}
	}

	private _refocusBrowser(url: string): void {
		try {
			const parsed = vscode.Uri.parse(url, true);
			if (parsed.scheme !== 'http' && parsed.scheme !== 'https') {
				this._log(`Refusing to refocus to non-http(s) URL (scheme=${parsed.scheme})`);
				return;
			}
			void vscode.env.openExternal(parsed);
			this._log(`Refocused browser to: ${url}`);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			this._log(`Failed to refocus browser: ${msg}`);
		}
	}

	private _startDevServer(requestId: string, sessionId: string, command: string, name?: string, cwd?: string): void {
		try {
			const terminalName = name || 'Mosayic: Dev Server';
			const workingDir = cwd || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

			this._log(`Starting dev server [${sessionId}]: ${this._redact(command)} in ${workingDir ?? '(no cwd)'}`);

			this._terminalRegistry.create(
				sessionId,
				command,
				terminalName,
				workingDir,
				(text) => {
					// Stream output to backend
					this._sendJson({
						type: 'dev_server_output',
						session_id: sessionId,
						text,
					});
				},
				(code) => {
					// Notify backend that the server exited
					this._log(`Dev server [${sessionId}] exited with code ${code}`);
					this._sendJson({
						type: 'dev_server_exited',
						session_id: sessionId,
						exit_code: code,
					});
				},
			);

			this._sendJson({ type: 'dev_server_started', request_id: requestId, session_id: sessionId });
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			this._log(`_startDevServer failed: ${msg}`);
			this._sendJson({ type: 'dev_server_error', request_id: requestId, session_id: sessionId, error: msg });
		}
	}

	private _stopDevServer(requestId: string, sessionId: string): void {
		try {
			this._log(`Stopping dev server [${sessionId}]`);
			this._terminalRegistry.dispose(sessionId);
			this._sendJson({ type: 'dev_server_stopped', request_id: requestId, session_id: sessionId });
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			this._log(`_stopDevServer failed: ${msg}`);
			this._sendJson({ type: 'dev_server_error', request_id: requestId, session_id: sessionId, error: msg });
		}
	}

	private _terminalInput(sessionId: string, text: string): void {
		const sent = this._terminalRegistry.sendInput(sessionId, text);
		if (!sent) {
			this._log(`terminal_input: no active session ${sessionId}`);
		}
	}

	private _devServerStatus(requestId: string, sessionId: string): void {
		const running = this._terminalRegistry.has(sessionId);
		this._sendJson({ type: 'dev_server_status_result', request_id: requestId, session_id: sessionId, running });
	}

	private _sendJson(data: Record<string, unknown>): void {
		if (this._ws?.readyState === WebSocket.OPEN) {
			this._ws.send(JSON.stringify(data));
		}
	}

	private _sendResult(requestId: string, stdout: string, stderr: string, exitCode: number): void {
		if (this._ws?.readyState === WebSocket.OPEN) {
			this._ws.send(JSON.stringify({
				type: 'command_result',
				request_id: requestId,
				stdout,
				stderr,
				exit_code: exitCode,
			}));
		}
	}

	private _sendOutput(requestId: string, text: string): void {
		if (this._ws?.readyState === WebSocket.OPEN) {
			this._ws.send(JSON.stringify({
				type: 'command_output',
				request_id: requestId,
				text,
			}));
		}
	}

	private _startPing(): void {
		this._stopPing();
		this._pingTimer = setInterval(() => {
			if (this._ws?.readyState === WebSocket.OPEN) {
				this._ws.send(JSON.stringify({ type: 'ping' }));
			}
		}, PING_INTERVAL);
	}

	private _stopPing(): void {
		if (this._pingTimer) {
			clearInterval(this._pingTimer);
			this._pingTimer = undefined;
		}
	}

	private _scheduleReconnect(): void {
		if (this._reconnectAttempt >= MAX_RECONNECT_ATTEMPTS) {
			this._logConn(`Giving up after ${MAX_RECONNECT_ATTEMPTS} reconnect attempts.`);
			this._setState('error', 'max reconnects exceeded');
			this._promptSignIn();
			return;
		}

		const delay = RECONNECT_DELAYS[Math.min(this._reconnectAttempt, RECONNECT_DELAYS.length - 1)];
		this._reconnectAttempt++;
		this._logConn(`Reconnecting in ${delay / 1000}s (attempt ${this._reconnectAttempt}/${MAX_RECONNECT_ATTEMPTS}).`);
		this._setState('reconnecting', `attempt ${this._reconnectAttempt}/${MAX_RECONNECT_ATTEMPTS}`);
		if (this._reconnectTimer) {
			clearTimeout(this._reconnectTimer);
		}
		this._reconnectTimer = setTimeout(() => {
			this._reconnectTimer = undefined;
			if (!this._disposed) { void this.connect(); }
		}, delay);
	}

	private _cleanup(): void {
		this._stopPing();
		if (this._reconnectTimer) {
			clearTimeout(this._reconnectTimer);
			this._reconnectTimer = undefined;
		}
		if (this._ws) {
			this._ws.removeAllListeners();
			if (this._ws.readyState === WebSocket.OPEN || this._ws.readyState === WebSocket.CONNECTING) {
				this._ws.close();
			}
			this._ws = undefined;
		}
	}

	private _redact(text: string): string {
		return text
			// Flag-style secrets: --password foo, --token foo, --api-key foo
			.replace(/(--(?:password|passwd|token|api[-_]?key|secret)\s+)\S+/gi, '$1****')
			// KEY=value where KEY contains a credential-ish word
			.replace(/([A-Z_]*(?:TOKEN|SECRET|KEY|PASSWORD|CREDENTIAL|AUTH)[A-Z_]*=)\S+/gi, '$1****')
			// ?token=..., ?key=..., ?apikey=..., ?password=...
			.replace(/(\?(?:token|api[-_]?key|key|password|auth)=)[^&\s]+/gi, '$1****')
			// Authorization: Bearer foo | Authorization: Basic foo
			.replace(/(Authorization:\s*(?:Bearer|Basic|Token)\s+)\S+/gi, '$1****')
			.replace(/(Bearer\s+)[A-Za-z0-9._\-~+/=]+/g, '$1****')
			// URLs with embedded credentials, including protocols like postgres, mysql, mongodb, redis, amqp
			.replace(/\b((?:[a-z][a-z0-9+.\-]*:\/\/)[^\s:@/]+):([^\s@/]+)@/gi, '$1:****@');
	}

	private _log(message: string): void {
		this._outputChannel.appendLine(`[${new Date().toLocaleTimeString()}] [info] ${message}`);
	}

	private _logAuth(message: string): void {
		this._outputChannel.appendLine(`[${new Date().toLocaleTimeString()}] [auth] ${message}`);
	}

	private _logConn(message: string): void {
		this._outputChannel.appendLine(`[${new Date().toLocaleTimeString()}] [conn] ${message}`);
	}

	dispose(): void {
		this._disposed = true;
		this._cleanup();
		for (const listener of this._activeTerminalListeners) {
			try { listener.dispose(); } catch { /* best-effort */ }
		}
		this._activeTerminalListeners = [];
		this._terminalRegistry.disposeAll();
		this._outputChannel.dispose();
	}
}
