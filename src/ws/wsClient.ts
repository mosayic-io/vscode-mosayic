import * as vscode from 'vscode';
import { spawn } from 'child_process';
import { WebSocket } from 'ws';
import { getApiUrl, isInsecureRemoteUrl, getConfirmMode, isAllowlistedCommand } from '../config';
import { TerminalRegistry } from './managedTerminal';

const RECONNECT_DELAYS = [1000, 2000, 5000, 10000, 30000];
const PING_INTERVAL = 30000;
const MAX_RECONNECT_ATTEMPTS = 10;
const MAX_OUTPUT_BYTES = 10 * 1024 * 1024; // 10 MB

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
	// Set by the 'error' handler when an HTTP 403 is detected during the
	// WebSocket upgrade. The ws library guarantees 'error' fires before
	// 'close', so the 'close' handler reads this flag safely.
	private _upgradeRejected = false;

	constructor(
		getToken: () => Promise<string | undefined>,
		refreshToken?: () => Promise<boolean>,
	) {
		this._getToken = getToken;
		this._refreshToken = refreshToken;
		this._outputChannel = vscode.window.createOutputChannel('Mosayic WebSocket');
	}

	async connect(): Promise<void> {
		if (this._disposed) {
			return;
		}

		this._cleanup();
		this._upgradeRejected = false;

		const token = await this._getToken();
		if (!token) {
			this._log('No auth token available, skipping WebSocket connection');
			return;
		}

		const apiUrl = getApiUrl();

		if (isInsecureRemoteUrl(apiUrl)) {
			this._log('WARNING: Connecting over plaintext HTTP to a remote server. Tokens and commands will be sent unencrypted.');
		}

		const wsUrl = apiUrl.replace(/^http/, 'ws') + '/ws';

		this._log(`Connecting to ${apiUrl}/ws ...`);

		const ws = new WebSocket(wsUrl, {
			headers: {
				'Authorization': `Bearer ${token}`,
			},
		});
		this._ws = ws;

		ws.on('open', () => {
			this._log('Connected');
			this._reconnectAttempt = 0;
			this._startPing();
		});

		ws.on('message', (raw: Buffer) => {
			try {
				const data = JSON.parse(raw.toString());
				this._handleMessage(data);
			} catch {
				this._log(`Failed to parse message: ${raw.toString()}`);
			}
		});

		ws.on('close', (code: number, reason: Buffer) => {
			this._stopPing();

			if (this._upgradeRejected || code === 4003) {
				this._log(`Authentication failed (code=${code})`);
				void this._handleAuthFailure();
				return;
			}

			this._log(`Disconnected (code=${code}, reason=${reason.toString()})`);
			if (!this._disposed) {
				this._scheduleReconnect();
			}
		});

		ws.on('error', (err: Error) => {
			if (err.message.includes('403')) {
				this._upgradeRejected = true;
				this._log('Server returned 403 — token is expired or invalid');
			} else {
				this._log(`Connection error: ${err.message}`);
			}
		});
	}

	disconnect(): void {
		this._cleanup();
		this._log('Disconnected by client');
	}

	private async _handleAuthFailure(): Promise<void> {
		if (!this._refreshToken) {
			this._log('No token refresh available — sign in again to reconnect');
			this._promptSignIn();
			return;
		}

		this._log('Attempting token refresh...');
		let refreshed = await this._refreshToken();

		if (!refreshed) {
			this._log('First refresh attempt failed, retrying in 2s...');
			await new Promise((r) => setTimeout(r, 2000));
			refreshed = await this._refreshToken();
		}

		if (refreshed) {
			this._log('Token refreshed — reconnecting');
			this._reconnectAttempt = 0;
			this._reconnectTimer = setTimeout(() => void this.connect(), 500);
		} else {
			this._log('Token refresh failed — sign in again to reconnect');
			this._promptSignIn();
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

	private _handleMessage(data: { type: string; request_id?: string; session_id?: string; command?: string; name?: string; title?: string; path?: string; text?: string }): void {
		if (data.type === 'command' && data.request_id && data.command) {
			void this._executeCommand(data.request_id, data.command);
		} else if (data.type === 'terminal_command' && data.request_id && data.command) {
			void this._runInTerminal(data.request_id, data.command, data.name);
		} else if (data.type === 'pick_folder' && data.request_id) {
			void this._pickFolder(data.request_id, data.title);
		} else if (data.type === 'open_folder' && data.request_id && data.path) {
			void this._openFolder(data.request_id, data.path);
		} else if (data.type === 'start_dev_server' && data.request_id && data.command && data.session_id) {
			this._startDevServer(data.request_id, data.session_id, data.command, data.name, data.path);
		} else if (data.type === 'stop_dev_server' && data.request_id && data.session_id) {
			this._stopDevServer(data.request_id, data.session_id);
		} else if (data.type === 'terminal_input' && data.session_id && data.text) {
			this._terminalInput(data.session_id, data.text);
		} else if (data.type === 'dev_server_status' && data.request_id && data.session_id) {
			this._devServerStatus(data.request_id, data.session_id);
		}
	}

	private async _executeCommand(requestId: string, command: string): Promise<void> {
		const mode = getConfirmMode();
		const needsPrompt = mode === 'always' || (mode === 'allowlisted' && !isAllowlistedCommand(command));

		if (needsPrompt) {
			const redacted = this._redact(command);
			const choice = await vscode.window.showWarningMessage(
				`Mosayic server wants to run a command: ${redacted}`,
				'Allow', 'Allow All', 'Deny',
			);

			if (choice === 'Allow All') {
				await vscode.workspace.getConfiguration('mosayic').update('confirmCommands', 'never', vscode.ConfigurationTarget.Global);
			} else if (choice !== 'Allow') {
				this._log(`Command denied by user: ${redacted}`);
				this._sendResult(requestId, '', 'Command denied by user', 1);
				return;
			}
		}

		this._log(`Executing: ${this._redact(command)}`);

		const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

		const child = spawn(command, {
			shell: true,
			cwd: workspaceFolder,
			timeout: 600_000,
		});

		let stdout = '';
		let stderr = '';

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

		child.on('close', (code: number | null) => {
			const exitCode = code ?? 1;
			this._log(`  Finished: exit_code=${exitCode}`);
			this._sendResult(requestId, stdout, stderr, exitCode);
		});

		child.on('error', (err: Error) => {
			this._log(`  Process error: ${err.message}`);
			this._sendResult(requestId, stdout, stderr + err.message, 1);
		});
	}

	private async _runInTerminal(requestId: string, command: string, name?: string): Promise<void> {
		const mode = getConfirmMode();
		const needsPrompt = mode === 'always' || (mode === 'allowlisted' && !isAllowlistedCommand(command));

		if (needsPrompt) {
			const redacted = this._redact(command);
			const choice = await vscode.window.showWarningMessage(
				`Mosayic server wants to run in terminal: ${redacted}`,
				'Allow', 'Allow All', 'Deny',
			);

			if (choice === 'Allow All') {
				await vscode.workspace.getConfiguration('mosayic').update('confirmCommands', 'never', vscode.ConfigurationTarget.Global);
			} else if (choice !== 'Allow') {
				this._log(`Terminal command denied by user: ${redacted}`);
				this._sendJson({ type: 'terminal_result', request_id: requestId, status: 'denied' });
				return;
			}
		}

		const terminalName = name || 'Mosayic';
		this._log(`Opening terminal "${terminalName}": ${this._redact(command)}`);

		const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		const terminal = vscode.window.createTerminal({
			name: terminalName,
			cwd: workspaceFolder,
			iconPath: new vscode.ThemeIcon('rocket'),
		});
		terminal.show();
		terminal.sendText(command);

		this._sendJson({ type: 'terminal_result', request_id: requestId, status: 'opened' });

		// Notify when terminal closes
		const listener = vscode.window.onDidCloseTerminal((closed) => {
			if (closed === terminal) {
				listener.dispose();
				this._log(`Terminal "${terminalName}" closed`);
				this._sendJson({ type: 'terminal_closed', request_id: requestId });
			}
		});
	}

	private async _openFolder(requestId: string, folderPath: string): Promise<void> {
		this._log(`Opening folder: ${folderPath}`);
		const uri = vscode.Uri.file(folderPath);
		this._sendJson({ type: 'open_folder_result', request_id: requestId, status: 'opened' });
		// This reloads the window — the extension will reconnect after
		await vscode.commands.executeCommand('vscode.openFolder', uri, { forceNewWindow: false });
	}

	private async _pickFolder(requestId: string, title?: string): Promise<void> {
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
	}

	private _startDevServer(requestId: string, sessionId: string, command: string, name?: string, cwd?: string): void {
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
	}

	private _stopDevServer(requestId: string, sessionId: string): void {
		this._log(`Stopping dev server [${sessionId}]`);
		this._terminalRegistry.dispose(sessionId);
		this._sendJson({ type: 'dev_server_stopped', request_id: requestId, session_id: sessionId });
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
			this._log(`Giving up after ${MAX_RECONNECT_ATTEMPTS} reconnect attempts`);
			this._promptSignIn();
			return;
		}

		const delay = RECONNECT_DELAYS[Math.min(this._reconnectAttempt, RECONNECT_DELAYS.length - 1)];
		this._reconnectAttempt++;
		this._log(`Reconnecting in ${delay / 1000}s (attempt ${this._reconnectAttempt}/${MAX_RECONNECT_ATTEMPTS})`);
		this._reconnectTimer = setTimeout(() => void this.connect(), delay);
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
			.replace(/(--password\s+)\S+/gi, '$1****')
			.replace(/(--token\s+)\S+/gi, '$1****')
			.replace(/([A-Z_]*(?:TOKEN|SECRET|KEY|PASSWORD|CREDENTIAL|AUTH)[A-Z_]*=)\S+/gi, '$1****')
			.replace(/(\?token=)\S+/gi, '$1****')
			.replace(/(Bearer\s+)\S+/gi, '$1****');
	}

	private _log(message: string): void {
		this._outputChannel.appendLine(`[${new Date().toLocaleTimeString()}] ${message}`);
	}

	dispose(): void {
		this._disposed = true;
		this._cleanup();
		this._terminalRegistry.disposeAll();
		this._outputChannel.dispose();
	}
}
