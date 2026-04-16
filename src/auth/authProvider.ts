import * as vscode from 'vscode';
import { randomBytes } from 'crypto';
import { UriEventHandler } from './uriHandler';
import { AUTH_TYPE, AUTH_NAME, getApiUrl } from '../config';

export { AUTH_TYPE };

const SESSIONS_KEY = 'mosayic.sessions';
const REFRESH_TOKEN_KEY = 'mosayic.refreshToken';

interface TokenData {
	access_token: string;
	refresh_token: string;
	user_id: string;
	email: string;
}

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

		this._sessionChangeEmitter.fire({ added: [session], removed: [], changed: [] });

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

	async refreshSession(): Promise<vscode.AuthenticationSession | undefined> {
		const refreshToken = await this._context.secrets.get(REFRESH_TOKEN_KEY);
		if (!refreshToken) {
			return undefined;
		}

		const apiUrl = getApiUrl();
		try {
			const response = await fetch(`${apiUrl}/auth/vscode/refresh`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ refresh_token: refreshToken }),
			});

			if (!response.ok) {
				// Capture sessions before deleting so the change event reports them
				const sessions = await this.getSessions();
				await this._context.secrets.delete(SESSIONS_KEY);
				await this._context.secrets.delete(REFRESH_TOKEN_KEY);
				this._sessionChangeEmitter.fire({ added: [], removed: sessions, changed: [] });
				return undefined;
			}

			const data = await response.json() as TokenData;
			const sessions = await this.getSessions();
			const oldSession = sessions[0];
			if (!oldSession) {
				return undefined;
			}

			const newSession: vscode.AuthenticationSession = {
				...oldSession,
				accessToken: data.access_token,
			};

			await this._context.secrets.store(SESSIONS_KEY, JSON.stringify([newSession]));
			await this._context.secrets.store(REFRESH_TOKEN_KEY, data.refresh_token);

			this._sessionChangeEmitter.fire({ added: [], removed: [], changed: [newSession] });
			return newSession;
		} catch (e: unknown) {
			const msg = e instanceof Error ? e.message : String(e);
			console.warn(`[Mosayic] Token refresh failed: ${msg}`);
			return undefined;
		}
	}

	private async _login(): Promise<TokenData> {
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

				const loginUrl = `${apiUrl}/auth/vscode/login?nonce=${nonce}&callback_uri=${encodeURIComponent(callbackUri.toString())}`;

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
