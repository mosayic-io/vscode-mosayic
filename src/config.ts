import * as vscode from 'vscode';

export const AUTH_TYPE = 'mosayic';
export const AUTH_NAME = 'Mosayic';

export const PROD_API_URL = 'https://mosayic-api-service-336793731775.us-east1.run.app';
export const DEV_API_URL = 'http://127.0.0.1:8090';

export type Environment = 'prod' | 'dev' | 'custom';

export function getEnvironment(): Environment {
	const raw = vscode.workspace.getConfiguration('mosayic').get<string>('environment', 'prod');
	if (raw === 'prod' || raw === 'dev' || raw === 'custom') { return raw; }
	return 'prod';
}

export async function setEnvironment(env: Environment): Promise<void> {
	await vscode.workspace.getConfiguration('mosayic').update(
		'environment',
		env,
		vscode.ConfigurationTarget.Global,
	);
}

export function getApiUrl(): string {
	const env = getEnvironment();
	if (env === 'dev') { return DEV_API_URL; }
	if (env === 'custom') {
		return vscode.workspace.getConfiguration('mosayic').get<string>('apiUrl', PROD_API_URL);
	}
	return PROD_API_URL;
}

export type ConfirmMode = 'allowlisted' | 'always' | 'never';

export function getConfirmMode(): ConfirmMode {
	const raw = vscode.workspace.getConfiguration('mosayic').get<string>('confirmCommands', 'allowlisted');
	// Backwards compat: old boolean values may still be in user settings
	if (raw === 'true' || (raw as unknown) === true) { return 'always'; }
	if (raw === 'false' || (raw as unknown) === false) { return 'never'; }
	if (raw === 'allowlisted' || raw === 'always' || raw === 'never') { return raw; }
	return 'allowlisted';
}

/**
 * First tokens Mosayic's backend is expected to invoke. Commands whose first
 * whitespace-separated token matches (case-insensitively) are auto-approved in
 * "allowlisted" mode. List is intentionally conservative — only the CLIs the
 * Mosayic workflow actually drives.
 */
const ALLOWED_FIRST_TOKENS = new Set<string>([
	'gh',
	'gcloud',
	'expo',
	'eas',
	'supabase',
	'npm',
	'npx',
	'node',
	// Windows-only: nvm-for-windows ships a real `nvm` binary. On macOS/Linux
	// nvm is a shell function and never appears as a first token.
	'nvm',
	'docker',
	'mkdir',
	'git',
	'unzip',
	'sed',
	'jq',
	'ssh-keygen',
	'rm',
	'mv',
	'cd',
	'printf',
	'uv',
	// POSIX file/string tests used by install-probes (e.g. nvm detection) and
	// conditional scaffold steps. Both forms accept the same predicates; the
	// bracket form is a shell builtin in practice.
	'test',
	'[',
	// Preview flow uses these to discover the LAN IP (`hostname -I | awk ...`)
	// and reclaim dev-server ports (`lsof -ti:8081 | xargs kill -9`).
	'hostname',
	'lsof',
	// POSIX `source` builtin — the Supabase setup flow prefixes every
	// Node/nvm call on macOS/Linux with `. "$HOME/.nvm/nvm.sh" >/dev/null 2>&1
	// && …` so `node` resolves under the user's nvm-selected version.
	'.',
]);

/**
 * Characters / sequences that unambiguously turn a single allowlisted command
 * into something the user did not consent to. Present in the command string =>
 * the command must NOT be auto-approved, even if the first token is allowed.
 *
 * We still allow the well-known chaining operators the Mosayic backend uses
 * (``&&``, ``||``, ``|``, ``>``, ``<``) — those are widespread in legitimate
 * scaffold / secrets flows. The list below is what has no benign use in our
 * backend-sent commands.
 */
const SHELL_ABUSE_PATTERNS: RegExp[] = [
	/;/,           // command separator
	/\$\(/,        // command substitution
	/`/,           // backtick command substitution
	/\r|\n/,       // embedded newline — injects another command line
];

export function isShellAbuseCommand(command: string): boolean {
	return SHELL_ABUSE_PATTERNS.some(re => re.test(command));
}

function firstToken(command: string): string {
	const trimmed = command.trimStart();
	const match = /^[^\s]+/.exec(trimmed);
	return match ? match[0] : '';
}

export function isAllowlistedCommand(command: string): boolean {
	if (isShellAbuseCommand(command)) {
		return false;
	}
	const token = firstToken(command).toLowerCase();
	return ALLOWED_FIRST_TOKENS.has(token);
}

/**
 * Returns true if the configured URL targets a remote host over plaintext HTTP.
 * Local addresses (127.0.0.1, localhost, ::1) are exempt.
 */
export function isInsecureRemoteUrl(url: string): boolean {
	if (!url.startsWith('http://')) {
		return false;
	}
	try {
		const host = new URL(url).hostname;
		return host !== '127.0.0.1' && host !== 'localhost' && host !== '::1';
	} catch {
		return false;
	}
}
