/**
 * The student's Supabase grant, kept HERE (0.2.24, capability `supabase_client`).
 *
 * Until 2026-11-08 the backend held every student's Supabase OAuth tokens
 * (encrypted) and the database passwords it generated, and drove Supabase's
 * Management API itself — full control of a student's live database, at
 * rest, on Kealy Studio's side. John: never what he meant to be holding.
 *
 * Now the consent is the same one click, but the tokens come to this
 * extension and live in VS Code's secret storage (the OS keychain), the same
 * custody as gh's GitHub token. The backend keeps nothing: it starts the
 * consent, hands the minted pair here (`supabase_tokens`), and renews a pair
 * on request (`POST /supabase-oauth/refresh`, the one moment a token passes
 * through it, in transit, because renewing needs the client secret).
 *
 * Everything that touches Supabase runs from here with that token:
 *
 *   supabase_status     — connected? which organisation?
 *   supabase_api        — ONE of the ALLOWED Management API paths (below)
 *   supabase_provision  — create a project; the database password is
 *                         generated here, kept in secret storage under the
 *                         project's ref until `supabase_finalize` has put it
 *                         in GitHub's secret, then deleted
 *   supabase_finalize   — once the project is healthy: its keys (the secret
 *                         key piped straight into gcloud, never returned),
 *                         the DATABASE_CONNECTION_STRING GitHub secret
 *   supabase_db_secret  — the GitHub secret from a password given now (an
 *                         existing project being linked, or one reset in the
 *                         dashboard); nothing kept
 *   supabase_forget     — hand back the refresh token (the backend revokes
 *                         it with the client secret) and delete the pair
 *
 * What never leaves this machine: the database password, the secret API
 * key, the Google client secret (read from the backend repo's supabase/.env
 * when auth config asks for it). What the backend never gets to ask for:
 * anything outside `ALLOWED` — in particular `/database/query`. Schema
 * changes ship as migrations through GitHub Actions, and this code can't
 * run SQL on a student's live database even if told to.
 */
import * as vscode from 'vscode';
import { spawn } from 'child_process';
import { readFileSync } from 'fs';
import { randomInt } from 'crypto';
import { getApiUrl } from './config';
import { resolveShellChoice } from './shell';
import { toolchainEnv } from './toolchain';

const MGMT = 'https://api.supabase.com';
const TOKENS_KEY = 'mosayic.supabase.tokens';
const DB_PASSWORD_KEY = (ref: string) => `mosayic.supabase.dbPassword.${ref}`;
/** Renew this many seconds before the access token dies. */
const EXPIRY_MARGIN_S = 60;

export interface SupabaseTokens { access_token: string; refresh_token: string; expires_at: number }

export class SupabaseNotConnected extends Error {
	constructor(message = 'Your Supabase account isn’t connected. Connect it and try again.') { super(message); }
}

/**
 * The Management API paths the backend may ask this extension to call, as
 * `METHOD path` patterns. A request outside this list is refused by name.
 * Deliberately absent: `/database/query` (SQL on the live database),
 * `/api-keys` and `/config/database/pooler` (secrets; handled only inside
 * `finalize` / `dbSecret`, whose results carry none of them).
 */
const REF = '[a-z0-9]{10,32}';
const ALLOWED: RegExp[] = [
	new RegExp('^GET /v1/organizations$'),
	new RegExp('^GET /v1/projects$'),
	new RegExp(`^GET /v1/projects/${REF}$`),
	new RegExp(`^GET /v1/projects/${REF}/config/auth$`),
	new RegExp(`^PATCH /v1/projects/${REF}/config/auth$`),
];
/** Fields of the auth config that are secrets: never handed back. */
const AUTH_SECRET_FIELDS = /(_secret$|^smtp_pass$|_private_key$|^hook_.*_secrets?$|_auth_token$|_access_key$|_api_key$)/;

export interface MgmtResult { status: number; data: unknown; [key: string]: unknown }

let refreshing: Promise<SupabaseTokens> | null = null;

export class SupabaseClient {
	constructor(
		private readonly secrets: vscode.SecretStorage,
		/** The extension's OWN Mosayic session, for the backend's renew endpoint; `fresh` asks for it to be renewed first. */
		private readonly apiToken: (fresh?: boolean) => Promise<string | undefined>,
		private readonly log: (line: string) => void,
	) {}

	// ── Custody ──────────────────────────────────────────────────

	async store(tokens: SupabaseTokens): Promise<void> {
		await this.secrets.store(TOKENS_KEY, JSON.stringify(tokens));
		this.log('Supabase: tokens stored in secret storage.');
	}

	private async read(): Promise<SupabaseTokens | null> {
		const raw = await this.secrets.get(TOKENS_KEY);
		if (!raw) { return null; }
		try {
			const t = JSON.parse(raw) as Partial<SupabaseTokens>;
			if (typeof t.access_token === 'string' && typeof t.refresh_token === 'string') {
				return { access_token: t.access_token, refresh_token: t.refresh_token, expires_at: Number(t.expires_at) || 0 };
			}
		} catch { /* unreadable: treat as none */ }
		return null;
	}

	/** Delete the pair; the refresh token goes back so the backend can revoke it. */
	async forget(): Promise<string | null> {
		const t = await this.read();
		await this.secrets.delete(TOKENS_KEY);
		this.log('Supabase: tokens forgotten.');
		return t?.refresh_token ?? null;
	}

	async isConnected(): Promise<boolean> {
		return (await this.read()) !== null;
	}

	/** A valid access token, renewed through the backend when needed. */
	private async accessToken(force = false): Promise<string> {
		const t = await this.read();
		if (!t) { throw new SupabaseNotConnected(); }
		if (!force && t.expires_at - Date.now() / 1000 > EXPIRY_MARGIN_S) { return t.access_token; }
		if (!refreshing) {
			refreshing = this.renew(t.refresh_token).finally(() => { refreshing = null; });
		}
		return (await refreshing).access_token;
	}

	private async renew(refreshToken: string, retried = false): Promise<SupabaseTokens> {
		const bearer = await this.apiToken(retried);
		if (!bearer) { throw new Error('Mosayic isn’t signed in in VS Code.'); }
		const res = await fetch(`${getApiUrl()}/supabase-oauth/refresh`, {
			method: 'POST',
			headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' },
			body: JSON.stringify({ refresh_token: refreshToken }),
			signal: AbortSignal.timeout(30_000),
		});
		if ((res.status === 401 || res.status === 403) && !retried) {
			// OUR Mosayic session was stale (an hour old, the socket kept alive
			// on pings), not the Supabase grant: renew it and try once more.
			// (0.2.25: this used to drop the Supabase pair for no reason.)
			return this.renew(refreshToken, true);
		}
		if (res.status === 409) {
			// Supabase said the refresh token is dead: how revocation presents itself.
			await this.secrets.delete(TOKENS_KEY);
			this.log('Supabase: renew refused by Supabase (409); tokens dropped.');
			throw new SupabaseNotConnected('Your Supabase authorization has expired or was revoked. Connect it again.');
		}
		if (!res.ok) { throw new Error(`Couldn’t renew the Supabase authorization (${res.status}).`); }
		const data = await res.json() as Partial<SupabaseTokens>;
		if (typeof data.access_token !== 'string' || typeof data.refresh_token !== 'string') {
			throw new Error('The renewed Supabase authorization was incomplete.');
		}
		const tokens = { access_token: data.access_token, refresh_token: data.refresh_token, expires_at: Number(data.expires_at) || 0 };
		await this.store(tokens);
		return tokens;
	}

	// ── The Management API ───────────────────────────────────────

	private async mgmt(method: string, path: string, body?: unknown, retry = true): Promise<MgmtResult> {
		const token = await this.accessToken();
		const res = await fetch(`${MGMT}${path}`, {
			method,
			headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
			body: body === undefined ? undefined : JSON.stringify(body),
			signal: AbortSignal.timeout(60_000),
		});
		if (res.status === 401 && retry) {
			await this.accessToken(true);
			return this.mgmt(method, path, body, false);
		}
		let data: unknown = null;
		const text = await res.text();
		if (text) { try { data = JSON.parse(text); } catch { data = text; } }
		return { status: res.status, data };
	}

	/** The backend's generic call, allowed paths only; auth-config reads come back without their secrets. */
	async relay(method: string, path: string, body?: unknown, envSecrets?: Record<string, { path: string; key: string }>): Promise<MgmtResult> {
		const key = `${method.toUpperCase()} ${path}`;
		if (!ALLOWED.some((re) => re.test(key))) {
			this.log(`Supabase: REFUSED ${key} (not an allowed path)`);
			return { status: 403, data: { code: 'not_allowed', message: `Mosayic’s extension doesn’t make that Supabase call (${key}).` } };
		}
		let payload = body;
		if (envSecrets && payload && typeof payload === 'object') {
			// Secrets the auth config needs that live only on this machine
			// (the Google client secret in the backend's supabase/.env):
			// merged here, so the backend never composes them.
			payload = { ...(payload as Record<string, unknown>) };
			for (const [field, from] of Object.entries(envSecrets)) {
				const value = readEnvValue(from.path, from.key);
				if (!value) {
					return { status: 409, data: { message: `${from.key} isn’t in ${from.path} yet.`, code: 'env_secret_missing', field } };
				}
				(payload as Record<string, unknown>)[field] = value;
			}
		}
		const result = await this.mgmt(method, path, payload);
		if (/\/config\/auth$/.test(path) && result.data && typeof result.data === 'object' && !Array.isArray(result.data)) {
			const scrubbed: Record<string, unknown> = {};
			for (const [k, v] of Object.entries(result.data as Record<string, unknown>)) {
				scrubbed[k] = AUTH_SECRET_FIELDS.test(k) ? (v ? '<set>' : v) : v;
			}
			return { status: result.status, data: scrubbed };
		}
		return result;
	}

	async status(): Promise<{ connected: boolean; organization_slug: string | null; organization_name: string | null; error?: string }> {
		if (!(await this.isConnected())) { return { connected: false, organization_slug: null, organization_name: null }; }
		try {
			const orgs = await this.mgmt('GET', '/v1/organizations');
			if (orgs.status === 401 || orgs.status === 403) {
				return { connected: false, organization_slug: null, organization_name: null };
			}
			const first = Array.isArray(orgs.data) ? orgs.data.find((o) => o && typeof o === 'object') as Record<string, unknown> | undefined : undefined;
			return {
				connected: true,
				organization_slug: first ? String(first.slug ?? first.id ?? '') || null : null,
				organization_name: first ? String(first.name ?? '') || null : null,
			};
		} catch (err) {
			if (err instanceof SupabaseNotConnected) { return { connected: false, organization_slug: null, organization_name: null }; }
			return { connected: true, organization_slug: null, organization_name: null, error: err instanceof Error ? err.message : String(err) };
		}
	}

	// ── Provisioning ─────────────────────────────────────────────

	/** Create the project. The password is made here and kept, under the ref, until the GitHub secret holds it. */
	async provision(input: { name: string; organization_slug: string; region: string }): Promise<{ ref?: string; status: number; error?: string }> {
		const password = generatePassword();
		const res = await this.mgmt('POST', '/v1/projects', {
			organization_slug: input.organization_slug, name: input.name, region: input.region, db_pass: password,
		});
		if (res.status < 200 || res.status >= 300) {
			return { status: res.status, error: describe(res.data) || `Supabase refused to create the project (${res.status}).` };
		}
		const d = (res.data ?? {}) as Record<string, unknown>;
		const ref = String(d.ref ?? d.id ?? '');
		if (!new RegExp(`^${REF}$`).test(ref)) { return { status: 502, error: 'Supabase returned an unexpected project ref.' }; }
		await this.secrets.store(DB_PASSWORD_KEY(ref), password);
		this.log(`Supabase: created project ${ref}; its database password is in secret storage until GitHub has it.`);
		return { ref, status: res.status };
	}

	/**
	 * Once the project is healthy: record-worthy facts back (URL, publishable
	 * key), the secret key into Google Secret Manager, the connection string
	 * into GitHub. Each part skips itself when told it's done.
	 */
	async finalize(input: {
		ref: string; api_path?: string | null; gcloud_project_id?: string | null;
		want_keys: boolean; want_vault: boolean; want_db_secret: boolean;
	}): Promise<{
		project_status: string; publishable_key?: string | null; url?: string;
		secret_vaulted: boolean; db_secret_set: boolean; warnings: string[]; error?: string;
	}> {
		const out = { project_status: 'UNKNOWN', secret_vaulted: false, db_secret_set: false, warnings: [] as string[] } as {
			project_status: string; publishable_key?: string | null; url?: string;
			secret_vaulted: boolean; db_secret_set: boolean; warnings: string[]; error?: string;
		};
		const project = await this.mgmt('GET', `/v1/projects/${input.ref}`);
		if (project.status !== 200) { out.error = describe(project.data) || `Couldn’t read the project (${project.status}).`; return out; }
		out.project_status = String((project.data as Record<string, unknown>)?.status ?? 'UNKNOWN');
		out.url = `https://${input.ref}.supabase.co`;
		if (out.project_status !== 'ACTIVE_HEALTHY') { return out; }

		let secretKey: string | null = null;
		if (input.want_keys || input.want_vault) {
			const keys = await this.mgmt('GET', `/v1/projects/${input.ref}/api-keys?reveal=true`);
			if (keys.status !== 200) {
				out.warnings.push(describe(keys.data) || `Couldn’t read the project’s API keys (${keys.status}).`);
			} else {
				const found = pickKeys(keys.data);
				out.publishable_key = found.publishable;
				secretKey = found.secret;
				if (!found.publishable) { out.warnings.push('Couldn’t find a publishable API key on the project.'); }
			}
		}

		if (input.want_vault) {
			if (!secretKey) {
				out.warnings.push('Couldn’t find a secret API key on the project.');
			} else if (!input.gcloud_project_id) {
				out.warnings.push('Set up your Google Cloud project first — the secret key is stored in its Secret Manager.');
			} else {
				const vaulted = await writeGcpSecret(input.gcloud_project_id, 'SUPABASE_SECRET_KEY', secretKey);
				if (vaulted.ok) { out.secret_vaulted = true; } else { out.warnings.push(vaulted.error); }
			}
		}

		if (input.want_db_secret) {
			const password = await this.secrets.get(DB_PASSWORD_KEY(input.ref));
			if (!password) {
				out.warnings.push('No database password is held for this project — give it under Secrets & environment (Update next to DATABASE_CONNECTION_STRING).');
			} else if (!input.api_path) {
				out.warnings.push('The connection-string secret will be set once your backend repository exists.');
			} else {
				const set = await this.setDbSecret(input.ref, input.api_path, password);
				if (set.ok) {
					out.db_secret_set = true;
					await this.secrets.delete(DB_PASSWORD_KEY(input.ref));
					this.log(`Supabase: GitHub has the connection string for ${input.ref}; the password is no longer held here.`);
				} else {
					out.warnings.push(set.error);
				}
			}
		}
		return out;
	}

	/** The GitHub secret from a password given now; nothing is kept. */
	async dbSecret(input: { ref: string; api_path: string; password?: string | null }): Promise<{ ok: boolean; error?: string }> {
		const password = input.password || (await this.secrets.get(DB_PASSWORD_KEY(input.ref)));
		if (!password) { return { ok: false, error: 'No database password to set the secret from.' }; }
		const set = await this.setDbSecret(input.ref, input.api_path, password);
		if (set.ok) { await this.secrets.delete(DB_PASSWORD_KEY(input.ref)); }
		return set;
	}

	private async setDbSecret(ref: string, apiPath: string, password: string): Promise<{ ok: true } | { ok: false; error: string }> {
		const pooler = await this.mgmt('GET', `/v1/projects/${ref}/config/database/pooler`);
		if (pooler.status !== 200) { return { ok: false, error: describe(pooler.data) || `Couldn’t read the pooler config (${pooler.status}).` }; }
		const entries = (Array.isArray(pooler.data) ? pooler.data : [pooler.data]).filter((e) => e && typeof e === 'object') as Record<string, unknown>[];
		const entry = entries.find((e) => e.pool_mode === 'transaction') ?? entries[0];
		if (!entry) { return { ok: false, error: 'Supabase didn’t report a pooler for this project.' }; }
		const host = entry.db_host, user = entry.db_user, port = entry.db_port, db = entry.db_name || 'postgres';
		if (!host || !user || !port) { return { ok: false, error: 'Supabase’s pooler config was missing its host details.' }; }
		const connectionString = `postgresql://${encodeURIComponent(String(user))}:${encodeURIComponent(password)}@${host}:${port}/${db}`;
		const result = await runWithInput('gh', ['secret', 'set', 'DATABASE_CONNECTION_STRING'], connectionString, apiPath);
		if (result.exitCode === null) { return { ok: false, error: 'GitHub didn’t answer in time while setting the secret. Try again.' }; }
		if (result.exitCode !== 0) { return { ok: false, error: result.stderr.trim() || 'GitHub didn’t accept the secret.' }; }
		return { ok: true };
	}
}

// ── Helpers ────────────────────────────────────────────────────

/** URL-unreserved characters only, so the connection string needs no escaping anywhere. */
function generatePassword(): string {
	const upper = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', lower = 'abcdefghijklmnopqrstuvwxyz', digits = '0123456789', symbols = '-._~';
	const pool = upper + lower + digits + symbols;
	const pick = (s: string) => s[randomInt(s.length)];
	const chars = [pick(upper), pick(lower), pick(digits), pick(symbols)];
	for (let i = 0; i < 28; i += 1) { chars.push(pick(pool)); }
	for (let i = chars.length - 1; i > 0; i -= 1) { const j = randomInt(i + 1); [chars[i], chars[j]] = [chars[j], chars[i]]; }
	return chars.join('');
}

function pickKeys(data: unknown): { publishable: string | null; secret: string | null } {
	let publishable: string | null = null, secret: string | null = null, anon: string | null = null, service: string | null = null;
	for (const entry of Array.isArray(data) ? data : []) {
		if (!entry || typeof entry !== 'object') { continue; }
		const e = entry as Record<string, unknown>;
		const key = String(e.api_key ?? ''), type = String(e.type ?? ''), name = String(e.name ?? '');
		if (type === 'publishable' || key.startsWith('sb_publishable_')) { publishable = publishable ?? key; }
		else if (type === 'secret' || key.startsWith('sb_secret_')) { secret = secret ?? key; }
		else if (name === 'anon') { anon = key; }
		else if (name === 'service_role') { service = key; }
	}
	return { publishable: publishable ?? anon, secret: secret ?? service };
}

function describe(data: unknown): string | null {
	if (data && typeof data === 'object') {
		const d = data as Record<string, unknown>;
		const m = d.message ?? d.error ?? d.msg;
		if (typeof m === 'string' && m) { return m.slice(0, 300); }
	}
	return typeof data === 'string' && data ? data.slice(0, 300) : null;
}

function readEnvValue(path: string, key: string): string | null {
	try {
		const text = readFileSync(path, 'utf8');
		const m = text.match(new RegExp(`^${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}=(.*)$`, 'm'));
		const v = m?.[1]?.trim().replace(/^["']|["']$/g, '');
		return v || null;
	} catch { return null; }
}

interface RunResult { exitCode: number | null; stdout: string; stderr: string }

/** Run a command with `input` on stdin, in Mosayic's shell (Git Bash on Windows) and PATH. The input never appears in a command line. */
function runWithInput(command: string, args: string[], input: string, cwd?: string): Promise<RunResult> {
	return new Promise((resolve) => {
		const child = spawn(command, args, { shell: resolveShellChoice().shell, env: toolchainEnv(), cwd, timeout: 60_000 });
		let stdout = '', stderr = '';
		child.stdout?.on('data', (d) => { stdout += String(d); });
		child.stderr?.on('data', (d) => { stderr += String(d); });
		child.on('error', (err) => resolve({ exitCode: 1, stdout, stderr: `${stderr}${err.message}` }));
		child.on('close', (code) => resolve({ exitCode: code, stdout, stderr }));
		child.stdin?.on('error', () => { /* the close handler reports */ });
		child.stdin?.end(input);
	});
}

/** The secret's value into Google Secret Manager: create, or add a version. The value rides stdin. */
async function writeGcpSecret(project: string, name: string, value: string): Promise<{ ok: true } | { ok: false; error: string }> {
	if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(project) || !/^[A-Za-z0-9_-]{1,255}$/.test(name)) {
		return { ok: false, error: 'The Google Cloud project id or secret name looks wrong.' };
	}
	const created = await runWithInput('gcloud', ['secrets', 'create', name, '--data-file=-', `--project=${project}`], value);
	if (created.exitCode === 0) { return { ok: true }; }
	if (/already exists/i.test(created.stderr)) {
		const added = await runWithInput('gcloud', ['secrets', 'versions', 'add', name, '--data-file=-', `--project=${project}`], value);
		if (added.exitCode === 0) { return { ok: true }; }
		return { ok: false, error: added.stderr.trim() || 'Couldn’t update the secret in Secret Manager.' };
	}
	return { ok: false, error: created.stderr.trim() || 'Couldn’t store the secret in Secret Manager.' };
}
