import * as vscode from 'vscode';
import { spawn, type ChildProcess } from 'child_process';
import { resolveCommandShell } from '../shell';

/**
 * A managed terminal that wraps a child process in a VS Code Pseudoterminal.
 *
 * - Output is visible in a VS Code terminal tab
 * - Output is also streamed to a callback for the backend
 * - Stdin can be written to from the frontend (via the backend/WebSocket)
 * - The user can type directly in the terminal too
 */
export class ManagedTerminal implements vscode.Pseudoterminal {
	private _writeEmitter = new vscode.EventEmitter<string>();
	// Pseudoterminal.onDidClose fires when the underlying process exits — VS
	// Code uses it to show "[Process exited with code N]" in the terminal.
	private _closeEmitter = new vscode.EventEmitter<number | void>();
	private _child: ChildProcess | undefined;
	private _closed = false;

	readonly onDidWrite = this._writeEmitter.event;
	readonly onDidClose = this._closeEmitter.event;

	constructor(
		private readonly _command: string,
		private readonly _cwd: string | undefined,
		private readonly _onOutput: (text: string) => void,
		private readonly _onExit: (code: number) => void,
	) {}

	open(_initialDimensions: vscode.TerminalDimensions | undefined): void {
		this._writeEmitter.fire('Mosayic: Starting process...\r\n');
		// Small delay to ensure the terminal is visible before spawn
		setTimeout(() => this._spawn(), 100);
	}

	close(): void {
		if (this._closed) return;
		this._closed = true;
		if (this._child && !this._child.killed) {
			this._child.kill();
		}
	}

	/** Handle keyboard input from the VS Code terminal UI */
	handleInput(data: string): void {
		if (this._child?.stdin?.writable) {
			this._child.stdin.write(data);
		}
	}

	/** Write to stdin programmatically (from frontend via WebSocket) */
	sendInput(data: string): void {
		if (this._child?.stdin?.writable) {
			this._child.stdin.write(data);
		}
	}

	private _spawn(): void {
		this._writeEmitter.fire(`\x1b[90m$ ${this._command}\x1b[0m\r\n`);
		if (this._cwd) {
			this._writeEmitter.fire(`\x1b[90m  cwd: ${this._cwd}\x1b[0m\r\n\r\n`);
		}

		const child = spawn(this._command, {
			shell: resolveCommandShell(),
			cwd: this._cwd,
			env: { ...process.env, FORCE_COLOR: '1', TERM: 'xterm-256color' },
		});
		this._child = child;

		child.stdout?.on('data', (chunk: Buffer) => {
			const text = chunk.toString();
			// Write to the VS Code terminal (convert \n to \r\n for proper rendering)
			this._writeEmitter.fire(text.replace(/\n/g, '\r\n'));
			// Stream to backend
			this._onOutput(text);
		});

		child.stderr?.on('data', (chunk: Buffer) => {
			const text = chunk.toString();
			this._writeEmitter.fire(text.replace(/\n/g, '\r\n'));
			this._onOutput(text);
		});

		child.on('close', (code: number | null) => {
			const exitCode = code ?? 1;
			this._writeEmitter.fire(`\r\n\x1b[90m[Process exited with code ${exitCode}]\x1b[0m\r\n`);
			this._writeEmitter.fire(`\x1b[90m[Terminal will remain open for inspection]\x1b[0m\r\n`);
			// Don't close the terminal UI — user may want to read the output —
			// but signal pseudoterminal closure so VS Code stops accepting input
			// and callers relying on onDidClose can clean up.
			this._closeEmitter.fire(exitCode);
			this._onExit(exitCode);
		});

		child.on('error', (err: Error) => {
			this._writeEmitter.fire(`\r\n\x1b[31m[Error: ${err.message}]\x1b[0m\r\n`);
			this._writeEmitter.fire(`\x1b[90m[Terminal will remain open for inspection]\x1b[0m\r\n`);
			this._closeEmitter.fire(1);
			this._onExit(1);
		});
	}
}

/**
 * Registry of active managed terminals, keyed by a session ID.
 * Allows the WebSocket client to look up terminals for stdin forwarding and status checks.
 */
export class TerminalRegistry {
	private _terminals = new Map<string, { pty: ManagedTerminal; terminal: vscode.Terminal }>();

	create(
		sessionId: string,
		command: string,
		name: string,
		cwd: string | undefined,
		onOutput: (text: string) => void,
		onExit: (code: number) => void,
	): vscode.Terminal {
		// Kill existing terminal with same session ID
		this.dispose(sessionId);

		const pty = new ManagedTerminal(command, cwd, onOutput, (code) => {
			onExit(code);
			this._terminals.delete(sessionId);
		});

		const terminal = vscode.window.createTerminal({
			name,
			pty,
			iconPath: new vscode.ThemeIcon('rocket'),
		});
		terminal.show();

		this._terminals.set(sessionId, { pty, terminal });
		return terminal;
	}

	sendInput(sessionId: string, data: string): boolean {
		const entry = this._terminals.get(sessionId);
		if (!entry) return false;
		entry.pty.sendInput(data);
		return true;
	}

	has(sessionId: string): boolean {
		return this._terminals.has(sessionId);
	}

	dispose(sessionId: string): void {
		const entry = this._terminals.get(sessionId);
		if (entry) {
			entry.terminal.dispose();
			this._terminals.delete(sessionId);
		}
	}

	disposeAll(): void {
		for (const [id] of this._terminals) {
			this.dispose(id);
		}
	}
}
