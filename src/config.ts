import * as vscode from 'vscode';

export const AUTH_TYPE = 'mosayic';
export const AUTH_NAME = 'Mosayic';

export const PROD_API_URL = 'https://mosayic-api.fly.dev';
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
		// An empty custom URL is the setting's default (it used to default to
		// a long-dead Cloud Run host, which a "custom" pick then dialled).
		// Empty means "nothing custom" — fall back to production.
		const custom = (vscode.workspace.getConfiguration('mosayic').get<string>('apiUrl', '') ?? '').trim();
		return custom || PROD_API_URL;
	}
	return PROD_API_URL;
}

export function environmentLabel(env: Environment): string {
	if (env === 'prod') { return 'Production'; }
	if (env === 'dev') { return 'Development'; }
	return 'Custom';
}

/**
 * Canonical form of a backend URL for comparison: scheme and host lowercased,
 * loopback names folded onto 127.0.0.1 (the dashboard says `localhost:8090`,
 * DEV_API_URL says `127.0.0.1:8090` — the same server), trailing slashes
 * dropped. Returns '' for anything that doesn't parse.
 */
export function normalizeBackendUrl(url: string): string {
	try {
		const u = new URL(url.trim());
		let host = u.hostname.toLowerCase();
		if (host === 'localhost' || host === '[::1]' || host === '::1') { host = '127.0.0.1'; }
		const port = u.port ? `:${u.port}` : '';
		const path = u.pathname.replace(/\/+$/, '');
		return `${u.protocol}//${host}${port}${path}`;
	} catch {
		return '';
	}
}

export function sameBackend(a: string, b: string): boolean {
	const na = normalizeBackendUrl(a);
	return na !== '' && na === normalizeBackendUrl(b);
}

/** The named environment a backend URL belongs to, if it is one of ours. */
export function environmentForUrl(url: string): Exclude<Environment, 'custom'> | undefined {
	if (sameBackend(url, PROD_API_URL)) { return 'prod'; }
	if (sameBackend(url, DEV_API_URL)) { return 'dev'; }
	return undefined;
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

/**
 * Strip content inside single-quoted regions from a shell command string.
 * Inside `'…'` POSIX shell interprets nothing — no substitution, no escapes,
 * no metacharacters — so a `;`, `$(`, or backtick that appears there is not
 * a real separator / substitution and shouldn't trip the abuse filter.
 *
 * Double-quoted content is left intact on purpose: shell DOES interpret
 * `$()` and backticks inside `"…"`, so the filter must still see them.
 * The concrete payload this exists for is `node -e '<js>'` probes whose
 * bodies are shlex-quoted by the backend (e.g. supabase_setup's LAN-IP
 * and .env-patch steps) — those contain `;` in the JS source.
 */
function stripSingleQuoted(command: string): string {
	let out = '';
	let i = 0;
	while (i < command.length) {
		if (command[i] === "'") {
			i++;
			while (i < command.length && command[i] !== "'") { i++; }
			if (i < command.length) { i++; } // skip closing quote
			continue;
		}
		out += command[i];
		i++;
	}
	return out;
}

export function isShellAbuseCommand(command: string): boolean {
	const stripped = stripSingleQuoted(command);
	return SHELL_ABUSE_PATTERNS.some(re => re.test(stripped));
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
