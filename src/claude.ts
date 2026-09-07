import * as vscode from 'vscode';
import { spawn, type ChildProcess } from 'child_process';
import { existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { resolveShellChoice } from './shell';

/**
 * The Claude Code bridge.
 *
 * Mosayic builds with Claude Code, and the dashboard's onboarding needs three
 * things it cannot see from a browser: is the Claude Code extension
 * installed, is it signed in, and can a prompt be handed to it. Anthropic's
 * extension is not ours, so everything here goes through public seams:
 *
 * - `vscode.extensions.getExtension` / `workbench.extensions.installExtension`
 *   for install state and a silent install.
 * - `claude auth status` for sign-in state. The extension ships its own
 *   binary under `resources/native-binary/`, and it and any PATH-installed
 *   `claude` share one credential store, so the bundled binary is the
 *   preferred probe: it exists whenever the extension does, and it needs no
 *   nvm gymnastics.
 * - `claude -p …` (headless mode, a documented CLI flag) to run a dashboard
 *   button's prompt end-to-end with the output streamed back, and the
 *   extension's `claude-vscode.editor.open` command to open a panel with a
 *   prompt waiting in the input box for the student to send themselves.
 *
 * Nothing here goes through the command consent filter: the binary and the
 * flags are fixed in this file, and the prompt travels as a single argv entry
 * (no shell), so the backend cannot turn a prompt into a shell command.
 * Claude Code's own permission system still governs what the prompt may do.
 */

export const CLAUDE_EXTENSION_ID = 'anthropic.claude-code';

const AUTH_STATUS_TIMEOUT_MS = 20_000;
// Long enough to cover VS Code's own trust prompt. Installing an extension
// can ask the student whether they trust the publisher, and 15s expired
// while that dialog was still on screen — so a perfectly good install
// reported "the extension has not appeared yet". The dashboard's request
// allows 130s, so this stays well inside it.
const INSTALL_SETTLE_TIMEOUT_MS = 60_000;
// Headless runs. This is a hard wall-clock kill, mid-write, with no resume, so
// it has to sit well clear of the real work: at eight minutes it was landing on
// legitimate runs (porting one screen of a builder app), and a student's only
// evidence was a step that failed for no stated reason. Thirty is long enough
// that hitting it means something is genuinely wedged rather than merely slow —
// the dashboard splits its own long jobs into per-run chunks that finish inside
// a few minutes, and it is the one holding the student's attention, not this.
const HEADLESS_RUN_TIMEOUT_MS = 30 * 60_000;
const MAX_PROMPT_CHARS = 8_000;

export interface ClaudeStatus {
	extension_installed: boolean;
	extension_version: string | null;
	/** Where `claude` was found: the extension's bundled binary, PATH, or nowhere. */
	cli: 'bundled' | 'path' | null;
	logged_in: boolean;
	email: string | null;
	subscription_type: string | null;
	auth_method: string | null;
	error: string | null;
}

interface ClaudeBinary {
	kind: 'bundled' | 'path';
	/** Absolute path for `bundled`; the bare command name for `path`. */
	command: string;
}

function findClaudeExtension(): vscode.Extension<unknown> | undefined {
	return vscode.extensions.getExtension(CLAUDE_EXTENSION_ID);
}

/**
 * Prefer the binary the Claude Code extension ships. Fall back to a PATH
 * `claude` (an `npm i -g @anthropic-ai/claude-code` install) — on macOS and
 * Linux that usually lives under nvm, which a non-login shell can't see, so
 * `sourceNvm()` is prepended when the shell path is taken.
 */
function findClaudeBinary(): ClaudeBinary | null {
	const ext = findClaudeExtension();
	if (ext) {
		const name = process.platform === 'win32' ? 'claude.exe' : 'claude';
		const bundled = join(ext.extensionPath, 'resources', 'native-binary', name);
		if (existsSync(bundled)) {
			return { kind: 'bundled', command: bundled };
		}
	}
	return { kind: 'path', command: 'claude' };
}

function sourceNvm(): string {
	return process.platform === 'win32' ? '' : '. "$HOME/.nvm/nvm.sh" >/dev/null 2>&1; ';
}

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

interface SpawnSpec {
	command: string;
	args: string[];
	shell: string | boolean;
}

/**
 * Build the spawn call for `claude <args>`. The bundled binary runs with no
 * shell at all (argv straight through). The PATH fallback needs a shell for
 * the nvm source, so every argument is single-quoted for it.
 */
function spawnSpec(binary: ClaudeBinary, args: string[]): SpawnSpec {
	if (binary.kind === 'bundled') {
		return { command: binary.command, args, shell: false };
	}
	const line = `${sourceNvm()}claude ${args.map(shellQuote).join(' ')}`;
	return { command: line, args: [], shell: resolveShellChoice().shell };
}

function runCaptured(
	spec: SpawnSpec,
	opts: { cwd: string; timeoutMs: number },
): Promise<{ stdout: string; stderr: string; exitCode: number; spawnError: string | null }> {
	return new Promise((resolve) => {
		let stdout = '';
		let stderr = '';
		let settled = false;
		const finish = (exitCode: number, spawnError: string | null = null) => {
			if (settled) { return; }
			settled = true;
			resolve({ stdout, stderr, exitCode, spawnError });
		};
		let child: ChildProcess;
		try {
			child = spawn(spec.command, spec.args, {
				shell: spec.shell,
				cwd: opts.cwd,
				timeout: opts.timeoutMs,
				env: process.env,
			});
		} catch (err) {
			finish(1, err instanceof Error ? err.message : String(err));
			return;
		}
		child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
		child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
		child.on('close', (code) => finish(code ?? 1));
		child.on('error', (err) => finish(1, err.message));
	});
}

function parseJsonObject(text: string): Record<string, unknown> | null {
	const start = text.indexOf('{');
	const end = text.lastIndexOf('}');
	if (start < 0 || end <= start) { return null; }
	try {
		const parsed: unknown = JSON.parse(text.slice(start, end + 1));
		return parsed !== null && typeof parsed === 'object' ? parsed as Record<string, unknown> : null;
	} catch {
		return null;
	}
}

function str(value: unknown): string | null {
	return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * Is Claude Code installed and signed in? Never throws — every failure lands
 * in `error` so the dashboard can show it instead of a spinner.
 */
export async function getClaudeStatus(log: (line: string) => void): Promise<ClaudeStatus> {
	const ext = findClaudeExtension();
	const status: ClaudeStatus = {
		extension_installed: ext !== undefined,
		extension_version: str((ext?.packageJSON as { version?: unknown } | undefined)?.version),
		cli: null,
		logged_in: false,
		email: null,
		subscription_type: null,
		auth_method: null,
		error: null,
	};

	const binary = findClaudeBinary();
	if (!binary) {
		return status;
	}

	const result = await runCaptured(
		spawnSpec(binary, ['auth', 'status']),
		{ cwd: homedir(), timeoutMs: AUTH_STATUS_TIMEOUT_MS },
	);
	const parsed = parseJsonObject(result.stdout);
	if (parsed) {
		status.cli = binary.kind;
		status.logged_in = parsed.loggedIn === true;
		status.email = str(parsed.email);
		status.subscription_type = str(parsed.subscriptionType);
		status.auth_method = str(parsed.authMethod);
		log(`claude auth status (${binary.kind}): loggedIn=${status.logged_in} ${status.email ?? ''}`.trimEnd());
		return status;
	}

	// No JSON: either there is no `claude` at all (exit 127 / ENOENT) or the
	// CLI printed something we don't understand. Say which.
	const combined = `${result.stderr}\n${result.stdout}`.trim();
	const notFound = result.spawnError?.includes('ENOENT')
		|| result.exitCode === 127
		|| /not found|not recognized/i.test(combined);
	if (notFound) {
		log(`claude not found (${binary.kind})`);
		return status;
	}
	status.cli = binary.kind;
	status.error = (result.spawnError ?? combined ?? 'claude auth status returned no JSON').slice(0, 300);
	log(`claude auth status failed (${binary.kind}, exit ${result.exitCode}): ${status.error}`);
	return status;
}

/**
 * Install the Claude Code extension without a marketplace round-trip. VS
 * Code's own install command does the download; we wait for the extension
 * to appear in the registry before answering.
 */
export async function installClaudeExtension(
	log: (line: string) => void,
): Promise<{ status: 'installed' | 'already_installed' | 'error'; error?: string }> {
	if (findClaudeExtension()) {
		return { status: 'already_installed' };
	}
	try {
		log('Installing the Claude Code extension…');
		await vscode.commands.executeCommand('workbench.extensions.installExtension', CLAUDE_EXTENSION_ID);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		log(`Claude Code install failed: ${msg}`);
		return { status: 'error', error: msg };
	}
	const deadline = Date.now() + INSTALL_SETTLE_TIMEOUT_MS;
	while (Date.now() < deadline) {
		if (findClaudeExtension()) {
			log('Claude Code extension installed.');
			return { status: 'installed' };
		}
		await new Promise((r) => setTimeout(r, 500));
	}
	return { status: 'error', error: 'The install command finished but the extension has not appeared yet. Reload VS Code and try again.' };
}

/**
 * Open a Claude Code panel, optionally with `prompt` waiting in the input
 * box. The extension's `editor.open(sessionId, initialPrompt)` signature is
 * observed, not documented, so a failure falls back to a plain terminal
 * running `claude` — the same product, in its other outfit.
 */
export async function openClaudePanel(
	prompt: string | undefined,
	cwd: string | undefined,
	log: (line: string) => void,
): Promise<{ status: 'opened' | 'not_installed' | 'error'; via?: 'panel' | 'terminal'; error?: string }> {
	const ext = findClaudeExtension();
	if (!ext) {
		return { status: 'not_installed' };
	}
	const trimmed = prompt?.trim().slice(0, MAX_PROMPT_CHARS) || undefined;
	try {
		if (!ext.isActive) {
			await ext.activate();
		}
		await vscode.commands.executeCommand('claude-vscode.editor.open', undefined, trimmed);
		log(trimmed ? 'Opened Claude Code with a prompt in the input box.' : 'Opened Claude Code.');
		return { status: 'opened', via: 'panel' };
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		log(`claude-vscode.editor.open failed (${msg}); falling back to a terminal.`);
	}
	try {
		const binary = findClaudeBinary();
		const terminal = vscode.window.createTerminal({
			name: 'Claude Code',
			cwd: cwd ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? homedir(),
			iconPath: new vscode.ThemeIcon('sparkle'),
		});
		terminal.show();
		const exe = binary?.kind === 'bundled' ? shellQuote(binary.command) : `${sourceNvm()}claude`;
		terminal.sendText(trimmed ? `${exe} ${shellQuote(trimmed)}` : exe);
		return { status: 'opened', via: 'terminal' };
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		return { status: 'error', error: msg };
	}
}

/**
 * One line of progress for the dashboard, distilled from Claude's
 * `stream-json` output: what it is saying, and which files it touches.
 */
/** A number off a stream event, or null — the shapes here are not ours to trust. */
function num(value: unknown): number | null {
	return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * The metrics Claude reports when a run ends. These used to be dropped on the
 * floor for every successful run, which left a forty-second run and an
 * eight-minute one looking identical afterwards — and made "why is this slow?"
 * unanswerable for the dashboard AND for whoever is maintaining the prompts.
 */
function readResultMetrics(event: Record<string, unknown>): Partial<HeadlessRunResult> {
	const usage = (event.usage ?? {}) as Record<string, unknown>;
	return {
		duration_ms: num(event.duration_ms),
		num_turns: num(event.num_turns),
		input_tokens: num(usage.input_tokens),
		output_tokens: num(usage.output_tokens),
		cache_read_tokens: num(usage.cache_read_input_tokens),
	};
}

function describeStreamEvent(event: Record<string, unknown>, cwd: string): string[] {
	const lines: string[] = [];
	if (event.type === 'assistant') {
		const message = event.message as { content?: unknown } | undefined;
		const content = Array.isArray(message?.content) ? message.content as Array<Record<string, unknown>> : [];
		for (const block of content) {
			if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
				lines.push(block.text.trim());
			} else if (block.type === 'tool_use') {
				const name = typeof block.name === 'string' ? block.name : 'tool';
				const input = (block.input ?? {}) as Record<string, unknown>;
				const file = typeof input.file_path === 'string' ? input.file_path : undefined;
				const rel = file && file.startsWith(cwd) ? file.slice(cwd.length).replace(/^[\\/]/, '') : file;
				if (name === 'Edit' || name === 'MultiEdit' || name === 'Write') {
					lines.push(`✎ Editing ${rel ?? 'a file'}`);
				} else if (name === 'Read') {
					lines.push(`Reading ${rel ?? 'a file'}`);
				} else if (name === 'Glob' || name === 'Grep') {
					lines.push('Looking through the project…');
				} else if (name === 'Bash' && typeof input.command === 'string') {
					lines.push(`$ ${input.command.slice(0, 120)}`);
				}
			}
		}
	} else if (event.type === 'result') {
		const isError = event.is_error === true || (typeof event.subtype === 'string' && event.subtype !== 'success');
		if (isError) {
			const detail = typeof event.result === 'string' ? event.result : String(event.subtype ?? 'error');
			lines.push(`Claude stopped: ${detail.slice(0, 300)}`);
		}
	}
	return lines;
}

export interface HeadlessRunHandle {
	cancel: () => void;
}

/**
 * How a run relates to the ones around it. A headless run starts cold — it has
 * read nothing — so the dashboard's multi-run jobs used to re-explore the same
 * project from scratch every time, and a repair run was handed a compiler error
 * about code it had written sixty seconds earlier with no memory of writing it.
 *
 *   `sessionId` — the id to give a NEW session, chosen by the caller so it can
 *                 resume it later without parsing anything out of the stream.
 *   `resume`    — continue that session instead: everything it read and wrote
 *                 is still in context, and the prompt cache is warm.
 *   `fork`      — with `resume`, branch rather than extend. Five sibling runs
 *                 that each fork the same parent inherit its exploration
 *                 without inheriting each other.
 */
export interface HeadlessRunSession {
	sessionId?: string;
	resume?: string;
	fork?: boolean;
}

/** What a finished run reports back. The metrics come from Claude's own `result` event. */
export interface HeadlessRunResult {
	exit_code: number;
	result_text: string | null;
	error: string | null;
	/** The session this run used — pass it back as `resume` to continue it. */
	session_id: string | null;
	/** Wall-clock milliseconds, as Claude measured them. */
	duration_ms: number | null;
	/** How many assistant turns it took. High with little output means it was exploring. */
	num_turns: number | null;
	input_tokens: number | null;
	output_tokens: number | null;
	/** Tokens served from the prompt cache — near zero means the run started cold. */
	cache_read_tokens: number | null;
}

/**
 * Run `prompt` through Claude Code headless (`claude -p`) in `cwd`, calling
 * `onLine` with human-readable progress and `onDone` once. Edits are
 * auto-accepted — the point of the dashboard's sample prompts is to watch a
 * change land without a permission dialog in the way — but anything else
 * Claude wants to do still goes through its own permission rules, which in
 * headless mode means "denied", never "silently allowed".
 */
export function runClaudeHeadless(
	prompt: string,
	cwd: string,
	onLine: (text: string) => void,
	onDone: (result: HeadlessRunResult) => void,
	log: (line: string) => void,
	session: HeadlessRunSession = {},
): HeadlessRunHandle {
	const binary = findClaudeBinary();
	const trimmed = prompt.trim().slice(0, MAX_PROMPT_CHARS);
	const blank: HeadlessRunResult = {
		exit_code: 1, result_text: null, error: null, session_id: null,
		duration_ms: null, num_turns: null,
		input_tokens: null, output_tokens: null, cache_read_tokens: null,
	};
	if (!binary || !trimmed) {
		queueMicrotask(() => onDone({ ...blank, error: binary ? 'Empty prompt' : 'Claude Code is not installed' }));
		return { cancel: () => undefined };
	}

	// A resumed session already knows the project; a fresh one is told which id
	// to use so the caller can come back to it. `--session-id` and `--resume`
	// are mutually exclusive — resuming defines the id by definition.
	const sessionArgs: string[] = [];
	if (session.resume) {
		sessionArgs.push('--resume', session.resume);
		if (session.fork) { sessionArgs.push('--fork-session'); }
	} else if (session.sessionId) {
		sessionArgs.push('--session-id', session.sessionId);
	}

	const spec = spawnSpec(binary, [
		'-p', trimmed,
		'--permission-mode', 'acceptEdits',
		'--output-format', 'stream-json',
		'--verbose',
		...sessionArgs,
	]);
	log(`claude -p (${binary.kind}) in ${cwd}${sessionArgs.length ? ` [${sessionArgs.join(' ')}]` : ''}: ${trimmed.slice(0, 80)}`);

	let child: ChildProcess;
	try {
		child = spawn(spec.command, spec.args, {
			shell: spec.shell,
			cwd,
			timeout: HEADLESS_RUN_TIMEOUT_MS,
			env: process.env,
		});
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		queueMicrotask(() => onDone({ ...blank, error: msg }));
		return { cancel: () => undefined };
	}

	let buffer = '';
	let stderr = '';
	let resultText: string | null = null;
	// Claude states its own session id on the `init` event and again on
	// `result`. Read it rather than assuming ours was honoured — a forked run's
	// id is one we never chose, and it is the id a repair run has to resume.
	let sessionId: string | null = session.resume && !session.fork ? session.resume : (session.sessionId ?? null);
	let metrics: Partial<HeadlessRunResult> = {};
	let done = false;
	const finish = (exitCode: number, error: string | null) => {
		if (done) { return; }
		done = true;
		onDone({ ...blank, ...metrics, exit_code: exitCode, result_text: resultText, error, session_id: sessionId });
	};

	const handleLine = (line: string) => {
		const trimmedLine = line.trim();
		if (!trimmedLine) { return; }
		const event = parseJsonObject(trimmedLine);
		if (!event) {
			onLine(trimmedLine);
			return;
		}
		if (typeof event.session_id === 'string' && event.session_id) {
			sessionId = event.session_id;
		}
		if (event.type === 'result') {
			if (typeof event.result === 'string') { resultText = event.result; }
			metrics = readResultMetrics(event);
		}
		for (const text of describeStreamEvent(event, cwd)) {
			onLine(text);
		}
	};

	child.stdout?.on('data', (chunk: Buffer) => {
		buffer += chunk.toString();
		let idx = buffer.indexOf('\n');
		while (idx >= 0) {
			handleLine(buffer.slice(0, idx));
			buffer = buffer.slice(idx + 1);
			idx = buffer.indexOf('\n');
		}
	});
	child.stderr?.on('data', (chunk: Buffer) => {
		const text = chunk.toString();
		if (stderr.length < 20_000) { stderr += text; }
		log(`  [claude stderr] ${text.trimEnd()}`);
	});
	child.on('close', (code) => {
		if (buffer.trim()) { handleLine(buffer); }
		const exitCode = code ?? 1;
		log(
			`  claude -p finished: exit_code=${exitCode}`
			+ ` session=${sessionId ?? '?'}`
			+ ` ${metrics.duration_ms != null ? `${Math.round(metrics.duration_ms / 1000)}s` : '?s'}`
			+ ` turns=${metrics.num_turns ?? '?'}`
			+ ` in=${metrics.input_tokens ?? '?'} out=${metrics.output_tokens ?? '?'}`
			+ ` cached=${metrics.cache_read_tokens ?? '?'}`,
		);
		finish(exitCode, exitCode === 0 ? null : (stderr.trim().slice(0, 500) || `claude exited with code ${exitCode}`));
	});
	child.on('error', (err) => {
		log(`  claude -p process error: ${err.message}`);
		finish(1, err.message);
	});

	return {
		cancel: () => {
			if (!child.killed) {
				child.kill();
			}
		},
	};
}
