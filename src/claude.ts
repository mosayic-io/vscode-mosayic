import * as vscode from 'vscode';
import { spawn, type ChildProcess } from 'child_process';
import { existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { mosayicTerminalOptions, toolchainEnv } from './toolchain';
import { gitBashPath, resolveShellChoice } from './shell';
import { KNOWLEDGE_PROMPT, knowledgeToolRules } from './knowledge';

/**
 * The environment every `claude` process gets: our PATH, and on Windows
 * where Git Bash is (0.2.19). Claude Code on Windows needs Git Bash and
 * normally finds it through git on PATH; telling it the path Mosayic already
 * found (`CLAUDE_CODE_GIT_BASH_PATH`, Claude Code's documented setting) covers
 * a PortableGit Mosayic installed a step ago, before any PATH change has
 * reached this process. A value the student set themselves wins.
 */
function claudeEnv(): NodeJS.ProcessEnv {
	const env = toolchainEnv();
	const bash = gitBashPath();
	if (!bash || env.CLAUDE_CODE_GIT_BASH_PATH) { return env; }
	return { ...env, CLAUDE_CODE_GIT_BASH_PATH: bash };
}

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
// What the backend may ask a run to be held to (capability ``claude_limits``,
// 0.2.17). Every value is clamped here as well as in the backend, because
// these land in a process's argv: a run can be made SHORTER or more limited
// than the defaults, never longer than the wall-clock kill above.
const MIN_RUN_TIMEOUT_MS = 60_000;
const MAX_TURNS_CAP = 500;
const MAX_BUDGET_USD_CAP = 50;
const MAX_ALLOWED_TOOLS = 40;
const MAX_SYSTEM_PROMPT_CHARS = 4_000;
// A tool rule as Claude Code writes them: a bare tool name (`Read`), or a
// tool with a pattern in brackets (`Bash(git status *)`). No brackets inside
// the pattern, no control characters.
const TOOL_RULE_RE = /^[A-Za-z][A-Za-z0-9_]{0,40}(\([^()\u0000-\u001f]{1,160}\))?$/;

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
	// Guarded, and never with a bare `;`: `.` is a POSIX special built-in, so
	// sourcing a file that isn't there kills /bin/sh on the spot — the command
	// after the separator never runs, whichever separator it is. On a Mac with
	// no nvm this made the PATH-installed `claude` unreachable.
	return process.platform === 'win32'
		? ''
		: '[ -s "$HOME/.nvm/nvm.sh" ] && . "$HOME/.nvm/nvm.sh" >/dev/null 2>&1 || true && ';
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
				env: claudeEnv(),
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
			// Git Bash on Windows (the line typed below is POSIX-quoted) and our PATH.
			...mosayicTerminalOptions(),
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

/**
 * What the backend may set on a run (0.2.17, capability ``claude_limits``).
 * Each one is optional, and a run with none of them is exactly the run it
 * always was: file edits auto-accepted, everything else denied, killed at
 * thirty minutes.
 *
 *   `allowedTools`       — extra Claude Code tool rules, e.g. `Bash(git status *)`.
 *                          Only what the backend names for THIS run; nothing
 *                          becomes allowed for any other run.
 *   `maxTurns`           — Claude stops after this many turns.
 *   `maxBudgetUsd`       — Claude stops once the run has cost this much (its
 *                          own estimate, which also counts on a subscription).
 *   `timeoutMs`          — a shorter wall-clock kill than the thirty minutes.
 *   `appendSystemPrompt` — told to Claude before the prompt: what it may and
 *                          may not do from here.
 */
export interface HeadlessRunLimits {
	allowedTools?: string[];
	maxTurns?: number;
	maxBudgetUsd?: number;
	timeoutMs?: number;
	appendSystemPrompt?: string;
	/**
	 * Claude's studio knowledge (0.2.22): the plugin folder `knowledge.ts`
	 * keeps in this extension's own storage. Never from the backend directly:
	 * `_claudeRun` sets it after fetching the pack the run's `knowledge_url`
	 * names. Adds `--plugin-dir`, read-only rules for that folder (it sits
	 * outside the run's folder, so a headless Read there is otherwise refused)
	 * and one line telling Claude the skill is there.
	 */
	pluginDir?: string;
}

/** Something Claude wanted to do that this run doesn't allow. */
export interface HeadlessDenial {
	tool: string;
	/** For Bash: the command it wanted to run. */
	command: string | null;
}

/** Why a run ended other than by finishing: a limit, or someone stopping it. */
export type HeadlessStopReason = 'max_turns' | 'budget' | 'timeout' | 'cancelled';

function finiteInRange(value: unknown, min: number, max: number): number | undefined {
	return typeof value === 'number' && Number.isFinite(value) ? Math.min(Math.max(value, min), max) : undefined;
}

/**
 * The limits a run may really be given: anything malformed is dropped, not
 * passed on, and numbers are clamped so the backend can only ever tighten a
 * run. Exported for the message parser, which hands over raw JSON.
 */
export function sanitizeLimits(raw: Record<string, unknown>): HeadlessRunLimits {
	const limits: HeadlessRunLimits = {};
	if (Array.isArray(raw.allowed_tools)) {
		const rules = raw.allowed_tools
			.filter((r): r is string => typeof r === 'string' && TOOL_RULE_RE.test(r))
			.slice(0, MAX_ALLOWED_TOOLS);
		if (rules.length) { limits.allowedTools = rules; }
	}
	const turns = finiteInRange(raw.max_turns, 1, MAX_TURNS_CAP);
	if (turns !== undefined) { limits.maxTurns = Math.round(turns); }
	const budget = finiteInRange(raw.max_budget_usd, 0.05, MAX_BUDGET_USD_CAP);
	if (budget !== undefined) { limits.maxBudgetUsd = Math.round(budget * 100) / 100; }
	const timeoutS = finiteInRange(raw.timeout_s, MIN_RUN_TIMEOUT_MS / 1000, HEADLESS_RUN_TIMEOUT_MS / 1000);
	if (timeoutS !== undefined) { limits.timeoutMs = Math.round(timeoutS * 1000); }
	if (typeof raw.append_system_prompt === 'string' && raw.append_system_prompt.trim()) {
		limits.appendSystemPrompt = raw.append_system_prompt.trim().slice(0, MAX_SYSTEM_PROMPT_CHARS);
	}
	return limits;
}

export function limitArgs(limits: HeadlessRunLimits): string[] {
	const args: string[] = [];
	const allowed = [...(limits.allowedTools ?? []), ...(limits.pluginDir ? knowledgeToolRules(limits.pluginDir) : [])];
	if (allowed.length) { args.push('--allowedTools', allowed.join(',')); }
	if (limits.maxTurns !== undefined) { args.push('--max-turns', String(limits.maxTurns)); }
	if (limits.maxBudgetUsd !== undefined) { args.push('--max-budget-usd', limits.maxBudgetUsd.toFixed(2)); }
	if (limits.pluginDir) { args.push('--plugin-dir', limits.pluginDir); }
	const systemPrompt = [limits.appendSystemPrompt, limits.pluginDir ? KNOWLEDGE_PROMPT : undefined].filter(Boolean).join('\n\n');
	if (systemPrompt) { args.push('--append-system-prompt', systemPrompt); }
	return args;
}

// How Claude Code words a refusal on the tool's own result. A command that
// merely failed (an exit code, "Permission denied" from the OS) comes back
// as an error too, so match only the refusal's own opening words; the
// result event's `permission_denials` catches anything this misses.
const DENIAL_TEXT_RE = /^\s*(this command requires approval|claude requested permissions? to use)/i;

function toolResultText(content: unknown): string {
	if (typeof content === 'string') { return content; }
	if (Array.isArray(content)) {
		return content
			.map((part) => (part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string' ? (part as { text: string }).text : ''))
			.join(' ');
	}
	return '';
}

/** The progress line a refusal is shown as, for a dashboard that reads only text. */
export function denialLine(denial: HeadlessDenial): string {
	return denial.command
		? `Not allowed from here: \`${denial.command.slice(0, 160)}\``
		: `Not allowed from here: ${denial.tool}`;
}

/**
 * Kill a headless run and everything under it. The PATH fallback runs
 * `claude` through a shell, so `child.kill()` only killed the shell and
 * Claude carried on underneath, writing files, until it was done — a Stop
 * or a time limit that did nothing (found 2026-11-03). On macOS and Linux
 * the run is its own process group (`detached` at spawn) and the whole group
 * goes; on Windows `taskkill /T` takes the tree.
 */
function killTree(child: ChildProcess): void {
	if (child.pid === undefined) {
		child.kill();
		return;
	}
	if (process.platform === 'win32') {
		try {
			spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
				.on('error', () => child.kill());
		} catch {
			child.kill();
		}
		return;
	}
	try {
		process.kill(-child.pid, 'SIGTERM');
	} catch {
		child.kill();
	}
}

function minutes(ms: number): string {
	const m = Math.round(ms / 60_000);
	return m === 1 ? 'a minute' : `${m} minutes`;
}

function stopReasonOf(event: Record<string, unknown>): HeadlessStopReason | null {
	if (event.subtype === 'error_max_turns') { return 'max_turns'; }
	if (event.subtype === 'error_max_budget_usd') { return 'budget'; }
	return null;
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
				}
				// Bash is described once its result is in (runClaudeHeadless):
				// a `$ command` line shown on the request read as "it ran",
				// including for the ones the run refused.
			}
		}
	} else if (event.type === 'result') {
		const isError = event.is_error === true || (typeof event.subtype === 'string' && event.subtype !== 'success');
		const reason = stopReasonOf(event);
		if (reason === 'max_turns') {
			lines.push('Claude stopped: it reached the step limit for this request.');
		} else if (reason === 'budget') {
			lines.push('Claude stopped: it reached the spending limit for this request.');
		} else if (Array.isArray(event.errors) && event.errors.some((e) => typeof e === 'string' && /no conversation found/i.test(e))) {
			// A session Claude doesn't know: the bridge starts the run cold
			// instead (wsClient), so this is not the end of anything.
		} else if (isError) {
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
	/** Why it ended early, when it did (0.2.17): a limit, or a stop. Null when it finished. */
	stop_reason?: HeadlessStopReason | null;
	/** Claude's own estimate of what the run cost, in US dollars (0.2.17). */
	cost_usd?: number | null;
	/** Everything the run refused (0.2.17), from Claude's own list at the end. */
	denials?: HeadlessDenial[];
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
	limits: HeadlessRunLimits = {},
	onDenial: (denial: HeadlessDenial) => void = () => undefined,
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
		...limitArgs(limits),
	]);
	const timeoutMs = limits.timeoutMs ?? HEADLESS_RUN_TIMEOUT_MS;
	log(
		`claude -p (${binary.kind}) in ${cwd}${sessionArgs.length ? ` [${sessionArgs.join(' ')}]` : ''}`
		+ ` [turns=${limits.maxTurns ?? '-'} budget=${limits.maxBudgetUsd ?? '-'} timeout=${Math.round(timeoutMs / 1000)}s`
		+ ` allowed=${limits.allowedTools?.length ?? 0}]: ${trimmed.slice(0, 80)}`,
	);

	let child: ChildProcess;
	try {
		child = spawn(spec.command, spec.args, {
			shell: spec.shell,
			cwd,
			env: claudeEnv(),
			// Nothing is ever piped in. Left open, `claude -p` waits three
			// seconds for stdin on every run before it starts.
			stdio: ['ignore', 'pipe', 'pipe'],
			// Its own process group, so a stop takes the whole run (killTree).
			detached: process.platform !== 'win32',
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
	let stopReason: HeadlessStopReason | null = null;
	let costUsd: number | null = null;
	// The tools Claude asked for, by id, so a result can be told apart: a Bash
	// command that ran gets its `$` line, one the run refused is a denial.
	const toolCalls = new Map<string, { name: string; command: string | null }>();
	const denials: HeadlessDenial[] = [];
	const deniedIds = new Set<string>();
	const deny = (id: string | null, denial: HeadlessDenial) => {
		if (id && deniedIds.has(id)) { return; }
		if (id) { deniedIds.add(id); }
		denials.push(denial);
		log(`  claude -p refused: ${denial.tool}${denial.command ? ` ${denial.command.slice(0, 120)}` : ''}`);
		onDenial(denial);
	};
	let done = false;
	let wallClock: ReturnType<typeof setTimeout> | undefined;
	const finish = (exitCode: number, error: string | null) => {
		if (done) { return; }
		done = true;
		clearTimeout(wallClock);
		onDone({
			...blank, ...metrics, exit_code: exitCode, result_text: resultText, error, session_id: sessionId,
			stop_reason: stopReason, cost_usd: costUsd, denials,
		});
	};

	const contentOf = (event: Record<string, unknown>): Array<Record<string, unknown>> => {
		const message = event.message as { content?: unknown } | undefined;
		return Array.isArray(message?.content) ? message.content as Array<Record<string, unknown>> : [];
	};

	const noteToolUse = (event: Record<string, unknown>) => {
		for (const block of contentOf(event)) {
			if (block.type !== 'tool_use' || typeof block.id !== 'string') { continue; }
			const input = (block.input ?? {}) as Record<string, unknown>;
			toolCalls.set(block.id, {
				name: typeof block.name === 'string' ? block.name : 'tool',
				command: typeof input.command === 'string' ? input.command : null,
			});
		}
	};

	const noteToolResults = (event: Record<string, unknown>) => {
		for (const block of contentOf(event)) {
			if (block.type !== 'tool_result' || typeof block.tool_use_id !== 'string') { continue; }
			const call = toolCalls.get(block.tool_use_id);
			if (!call) { continue; }
			if (block.is_error === true && DENIAL_TEXT_RE.test(toolResultText(block.content))) {
				deny(block.tool_use_id, { tool: call.name, command: call.command });
			} else if (call.name === 'Bash' && call.command) {
				onLine(`$ ${call.command.slice(0, 120)}`);
			}
		}
	};

	const noteFinalDenials = (event: Record<string, unknown>) => {
		if (!Array.isArray(event.permission_denials)) { return; }
		for (const raw of event.permission_denials as Array<Record<string, unknown>>) {
			if (!raw || typeof raw !== 'object') { continue; }
			const input = (raw.tool_input ?? {}) as Record<string, unknown>;
			deny(typeof raw.tool_use_id === 'string' ? raw.tool_use_id : null, {
				tool: typeof raw.tool_name === 'string' ? raw.tool_name : 'tool',
				command: typeof input.command === 'string' ? input.command : null,
			});
		}
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
		if (event.type === 'assistant') {
			noteToolUse(event);
		} else if (event.type === 'user') {
			noteToolResults(event);
		} else if (event.type === 'result') {
			if (typeof event.result === 'string') { resultText = event.result; }
			metrics = readResultMetrics(event);
			stopReason = stopReasonOf(event) ?? stopReason;
			costUsd = num(event.total_cost_usd);
			noteFinalDenials(event);
		}
		for (const text of describeStreamEvent(event, cwd)) {
			onLine(text);
		}
	};

	// Our own wall clock rather than spawn's `timeout`, so the result can say
	// that this is why the run ended.
	let killing = false;
	const stop = (reason: HeadlessStopReason) => {
		if (done || killing) { return; }
		killing = true;
		stopReason = stopReason ?? reason;
		killTree(child);
	};
	wallClock = setTimeout(() => {
		if (done || killing) { return; }
		log(`  claude -p hit its ${Math.round(timeoutMs / 1000)}s limit — stopping it`);
		onLine(`Claude stopped: it ran for ${minutes(timeoutMs)}, the time limit for this request.`);
		stop('timeout');
	}, timeoutMs);

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
			+ ` cached=${metrics.cache_read_tokens ?? '?'}`
			+ ` cost=${costUsd != null ? `$${costUsd.toFixed(2)}` : '?'}`
			+ ` stop=${stopReason ?? '-'} refused=${denials.length}`,
		);
		finish(exitCode, exitCode === 0 ? null : (stderr.trim().slice(0, 500) || `claude exited with code ${exitCode}`));
	});
	child.on('error', (err) => {
		log(`  claude -p process error: ${err.message}`);
		finish(1, err.message);
	});

	return {
		cancel: () => stop('cancelled'),
	};
}
