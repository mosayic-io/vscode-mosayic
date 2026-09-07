import * as vscode from 'vscode';
import { randomBytes } from 'crypto';
import { UriEventHandler } from './uriHandler';
import { AUTH_NAME, AUTH_TYPE, getApiUrl } from '../config';

const SESSIONS_KEY = 'mosayic.sessions';
const REFRESH_TOKEN_KEY = 'mosayic.refreshToken';

interface TokenData {
	access_token: string;
	refresh_token: string;
	user_id: string;
	email: string;
}

/**
 * What a refresh attempt found out.
 * - `refreshed`: new access token stored.
 * - `expired`: the backend rejected the refresh token (401/403). The session
 *   is gone and has been removed — the student must sign in again.
 * - `unavailable`: the backend couldn't be reached, or answered with
 *   something other than a verdict on the token (a 5xx, a restart, a
 *   proxy page). The session is KEPT: nothing is known to be wrong with
 *   it, and a restart of the local API mid-refresh used to sign John out.
 */
export type RefreshOutcome = 'refreshed' | 'expired' | 'unavailable';

// Must stay in step with the backend's _ALLOWED_PROVIDERS
// (mosayic-api, app/routes/vscode_auth_router.py).
const SIGN_IN_PROVIDERS: Array<vscode.QuickPickItem & { id: string }> = [
	{ id: 'google', label: 'Google' },
	{ id: 'github', label: 'GitHub' },
];

export class MosayicAuthenticationProvider implements vscode.AuthenticationProvider, vscode.Disposable {
	private _sessionChangeEmitter = new vscode.EventEmitter<vscode.AuthenticationProviderAuthenticationSessionsChangeEvent>();
	private _disposables: vscode.Disposable[] = [];

	readonly onDidChangeSessions = this._sessionChangeEmitter.event;

	constructor(
		private readonly _context: vscode.ExtensionContext,
		private readonly _uriHandler: UriEventHandler,
	) {
		this._disposables.push(
			vscode.authentication.registerAuthenticationProvider(AUTH_TYPE, AUTH_NAME, this, {
				supportsMultipleAccounts: false,
			})
		);
	}

	async getSessions(_scopes?: string[]): Promise<vscode.AuthenticationSession[]> {
		const data = await this._context.secrets.get(SESSIONS_KEY);
		if (!data) {
			return [];
		}
		try {
			return JSON.parse(data) as vscode.AuthenticationSession[];
		} catch {
			return [];
		}
	}

	async createSession(_scopes: string[]): Promise<vscode.AuthenticationSession> {
		const tokenData = await this._login();
		return this._storeNewSession(tokenData, []);
	}

	/**
	 * The dashboard → extension hand-off. The student is already signed in to
	 * the dashboard; its "Connect VS Code" button minted a one-time code and
	 * opened `vscode://mosayic.vscode-mosayic/handoff?code=…&email=…`. We trade
	 * the code for a session of our own — no browser round-trip, no second
	 * Google sign-in, and by construction the same account as the dashboard.
	 *
	 * `emailHint` is the address the dashboard put in the URI. It's a display
	 * hint, not a credential: the session the backend mints is the truth, and
	 * if it belongs to anyone else the hand-off is refused — a crafted link
	 * can't sign this VS Code into an account the student didn't see named.
	 * Replaces whatever session was stored (one account at a time).
	 */
	async createSessionFromHandoff(code: string, emailHint: string): Promise<vscode.AuthenticationSession> {
		const apiUrl = getApiUrl();
		const response = await fetch(`${apiUrl}/auth/vscode/exchange`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ code }),
		});

		if (!response.ok) {
			let detail = `the backend answered ${response.status}`;
			try {
				const body = await response.json() as { detail?: unknown };
				if (typeof body.detail === 'string' && body.detail) { detail = body.detail; }
			} catch {
				// non-JSON error body — keep the status text
			}
			throw new Error(detail);
		}

		const data = await response.json() as Partial<TokenData>;
		if (!data.access_token || !data.refresh_token || !data.user_id) {
			throw new Error('Incomplete authentication data received');
		}
		const email = data.email ?? '';
		if (emailHint && email.toLowerCase() !== emailHint.toLowerCase()) {
			throw new Error(`the sign-in code belonged to ${email || 'a different account'}, not ${emailHint}`);
		}

		const previous = await this.getSessions();
		return this._storeNewSession(
			{ access_token: data.access_token, refresh_token: data.refresh_token, user_id: data.user_id, email },
			previous,
		);
	}

	private async _storeNewSession(
		tokenData: TokenData,
		replacing: vscode.AuthenticationSession[],
	): Promise<vscode.AuthenticationSession> {
		const session: vscode.AuthenticationSession = {
			id: randomBytes(8).toString('hex'),
			accessToken: tokenData.access_token,
			account: {
				id: tokenData.user_id,
				label: tokenData.email,
			},
			scopes: [],
		};

		await this._context.secrets.store(SESSIONS_KEY, JSON.stringify([session]));
		await this._context.secrets.store(REFRESH_TOKEN_KEY, tokenData.refresh_token);

		this._sessionChangeEmitter.fire({ added: [session], removed: replacing, changed: [] });

		return session;
	}

	async removeSession(sessionId: string): Promise<void> {
		const sessions = await this.getSessions();
		const removed = sessions.find(s => s.id === sessionId);
		const remaining = sessions.filter(s => s.id !== sessionId);

		await this._context.secrets.store(SESSIONS_KEY, JSON.stringify(remaining));
		if (remaining.length === 0) {
			await this._context.secrets.delete(REFRESH_TOKEN_KEY);
		}

		if (removed) {
			this._sessionChangeEmitter.fire({ added: [], removed: [removed], changed: [] });
		}
	}

	/** Last refresh failure, for the caller's log line. */
	lastRefreshError: string | undefined;

	async refreshSession(): Promise<RefreshOutcome> {
		const refreshToken = await this._context.secrets.get(REFRESH_TOKEN_KEY);
		if (!refreshToken) {
			this.lastRefreshError = 'no refresh token stored';
			return 'expired';
		}

		const apiUrl = getApiUrl();
		let response: Response;
		try {
			response = await fetch(`${apiUrl}/auth/vscode/refresh`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ refresh_token: refreshToken }),
			});
		} catch (e: unknown) {
			// Network-level failure: the backend is down, or we're offline.
			// That says nothing about the token, so the session stays.
			this.lastRefreshError = e instanceof Error ? e.message : String(e);
			return 'unavailable';
		}

		if (response.status === 401 || response.status === 403) {
			// Only the backend's verdict on the token ends a session. Capture
			// sessions before deleting so the change event reports them.
			this.lastRefreshError = `the backend answered ${response.status}`;
			const sessions = await this.getSessions();
			await this._context.secrets.delete(SESSIONS_KEY);
			await this._context.secrets.delete(REFRESH_TOKEN_KEY);
			this._sessionChangeEmitter.fire({ added: [], removed: sessions, changed: [] });
			return 'expired';
		}
		if (!response.ok) {
			this.lastRefreshError = `the backend answered ${response.status}`;
			return 'unavailable';
		}

		let data: Partial<TokenData>;
		try {
			data = await response.json() as Partial<TokenData>;
		} catch {
			this.lastRefreshError = 'the backend answered with something that was not JSON';
			return 'unavailable';
		}
		if (!data.access_token || !data.refresh_token) {
			this.lastRefreshError = 'the backend answered without tokens';
			return 'unavailable';
		}

		const sessions = await this.getSessions();
		const oldSession = sessions[0];
		if (!oldSession) {
			this.lastRefreshError = 'no session stored';
			return 'expired';
		}

		const newSession: vscode.AuthenticationSession = {
			...oldSession,
			accessToken: data.access_token,
		};

		await this._context.secrets.store(SESSIONS_KEY, JSON.stringify([newSession]));
		await this._context.secrets.store(REFRESH_TOKEN_KEY, data.refresh_token);

		this._sessionChangeEmitter.fire({ added: [], removed: [], changed: [newSession] });
		this.lastRefreshError = undefined;
		return 'refreshed';
	}

	private async _login(): Promise<TokenData> {
		const provider = await vscode.window.showQuickPick(SIGN_IN_PROVIDERS, {
			placeHolder: 'How would you like to sign in to Mosayic?',
			ignoreFocusOut: true,
		});
		if (!provider) {
			throw new Error('Login cancelled');
		}

		return vscode.window.withProgress<TokenData>(
			{
				location: vscode.ProgressLocation.Notification,
				title: 'Signing in to Mosayic...',
				cancellable: true,
			},
			async (_progress, cancellationToken) => {
				const nonce = randomBytes(16).toString('hex');
				const apiUrl = getApiUrl();

				const callbackUri = await vscode.env.asExternalUri(
					vscode.Uri.parse(`${vscode.env.uriScheme}://mosayic.vscode-mosayic/auth-callback`)
				);

				const loginUrl = `${apiUrl}/auth/vscode/login?nonce=${nonce}&provider=${provider.id}&callback_uri=${encodeURIComponent(callbackUri.toString())}`;

				const tokenPromise = this._waitForCallback(nonce, cancellationToken);

				await vscode.env.openExternal(vscode.Uri.parse(loginUrl));

				return tokenPromise;
			}
		);
	}

	private _waitForCallback(nonce: string, cancellationToken: vscode.CancellationToken): Promise<TokenData> {
		return new Promise<TokenData>((resolve, reject) => {
			const timeout = setTimeout(() => {
				uriListener.dispose();
				cancelListener.dispose();
				reject(new Error('Login timed out after 2 minutes'));
			}, 120_000);

			const cancelListener = cancellationToken.onCancellationRequested(() => {
				clearTimeout(timeout);
				uriListener.dispose();
				cancelListener.dispose();
				reject(new Error('Login cancelled'));
			});

			const uriListener = this._uriHandler.event((uri) => {
				const query = new URLSearchParams(uri.query);

				if (query.get('nonce') !== nonce) {
					return;
				}

				clearTimeout(timeout);
				uriListener.dispose();
				cancelListener.dispose();

				const error = query.get('error');
				if (error) {
					reject(new Error(query.get('error_description') || error));
					return;
				}

				const access_token = query.get('access_token');
				const refresh_token = query.get('refresh_token');
				const user_id = query.get('user_id');
				const email = query.get('email') || '';

				if (!access_token || !refresh_token || !user_id) {
					reject(new Error('Incomplete authentication data received'));
					return;
				}

				resolve({ access_token, refresh_token, user_id, email });
			});
		});
	}

	dispose(): void {
		this._disposables.forEach(d => d.dispose());
	}
}
