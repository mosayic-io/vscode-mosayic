import * as vscode from 'vscode';
import { MosayicAuthenticationProvider } from './auth/authProvider';
import { UriEventHandler } from './auth/uriHandler';
import { MosayicWebSocketClient, type WsState } from './ws/wsClient';
import {
	AUTH_TYPE,
	DEV_API_URL,
	PROD_API_URL,
	environmentForUrl,
	environmentLabel,
	getApiUrl,
	getEnvironment,
	sameBackend,
	setEnvironment,
	type Environment,
} from './config';
import { runDockerPreflight } from './docker';

// Last backend URL that issued the currently stored session tokens. If the
// resolved API URL no longer matches, the session is stale (user switched
// environments) and we sign out rather than send prod tokens to dev (or vice
// versa).
const LAST_API_URL_KEY = 'mosayic.lastApiUrl';

export function activate(context: vscode.ExtensionContext) {
	const uriHandler = new UriEventHandler();
	context.subscriptions.push(vscode.window.registerUriHandler(uriHandler));

	const authProvider = new MosayicAuthenticationProvider(context, uriHandler);
	context.subscriptions.push(authProvider);

	// Our own session, read from our own provider — never through
	// `vscode.authentication.getSession`.
	//
	// That call answers only for accounts VS Code has recorded consent for,
	// and it answers with `undefined`, silently, when it hasn't. Consent is
	// recorded when a session is created THROUGH the account layer
	// (`createIfNone: true`), which the classic sign-in does — but the
	// dashboard hand-off calls the provider directly, because that is the
	// whole point of it. On a machine that had never done a classic sign-in,
	// the hand-off stored a perfectly good session that the extension then
	// could not see: "signed in as you@example.com", status bar "signed out",
	// no token, no WebSocket, no way for the student to tell why. It only
	// ever worked on machines that had signed in the old way once, which is
	// every developer's machine and no student's.
	//
	// The consent layer exists to stop OTHER extensions using an account.
	// This is the extension that owns the provider.
	const currentSession = async (): Promise<vscode.AuthenticationSession | undefined> =>
		(await authProvider.getSessions())[0];

	const stamp = () => new Date().toLocaleTimeString();

	const wsClient = new MosayicWebSocketClient(
		async () => {
			const session = await currentSession();
			return session?.accessToken;
		},
		async () => {
			const outcome = await authProvider.refreshSession();
			if (outcome !== 'refreshed') {
				wsClient.outputChannel.appendLine(
					`[${stamp()}] [auth] Token refresh against ${getApiUrl()} → ${outcome}` +
					(authProvider.lastRefreshError ? ` (${authProvider.lastRefreshError})` : ''),
				);
			}
			return outcome;
		},
	);
	context.subscriptions.push(wsClient);

	// Status bar — always visible so the user can see what the extension is doing
	const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
	statusBar.name = 'Mosayic';
	context.subscriptions.push(statusBar);

	function renderStatus(state: WsState, detail?: string): void {
		const apiUrl = getApiUrl();
		switch (state) {
			case 'signed-out':
				statusBar.text = '$(plug) Mosayic: signed out';
				statusBar.tooltip = `Not signed in. Click to sign in.\nAPI: ${apiUrl}`;
				statusBar.command = 'vscode-mosayic.signIn';
				statusBar.backgroundColor = undefined;
				break;
			case 'idle':
				statusBar.text = '$(circle-outline) Mosayic: idle';
				statusBar.tooltip = `Idle. API: ${apiUrl}`;
				statusBar.command = 'vscode-mosayic.showOutput';
				statusBar.backgroundColor = undefined;
				break;
			case 'connecting':
				statusBar.text = '$(sync~spin) Mosayic: connecting';
				statusBar.tooltip = `Connecting to ${detail ?? apiUrl}/ws`;
				statusBar.command = 'vscode-mosayic.showOutput';
				statusBar.backgroundColor = undefined;
				break;
			case 'connected':
				statusBar.text = '$(check) Mosayic: connected';
				statusBar.tooltip = `Connected to ${detail ?? apiUrl}/ws`;
				statusBar.command = 'vscode-mosayic.showOutput';
				statusBar.backgroundColor = undefined;
				break;
			case 'reconnecting':
				statusBar.text = `$(sync~spin) Mosayic: reconnecting`;
				statusBar.tooltip = `Reconnecting (${detail ?? ''}). API: ${apiUrl}`;
				statusBar.command = 'vscode-mosayic.showOutput';
				statusBar.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
				break;
			case 'standby':
				statusBar.text = '$(debug-disconnect) Mosayic: other window';
				statusBar.tooltip = 'Mosayic is connected in another VS Code window — dashboard actions run there. Click to use this window instead.';
				statusBar.command = 'vscode-mosayic.connect';
				statusBar.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
				break;
			case 'members-only':
				statusBar.text = '$(lock) Mosayic: members only';
				statusBar.tooltip = 'Mosayic is part of the Kealy Studio full membership — this account doesn’t have one. Join at https://kealy.studio, then click to connect again.';
				statusBar.command = 'vscode-mosayic.connect';
				statusBar.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
				break;
			case 'auth-error':
				statusBar.text = '$(key) Mosayic: auth failed';
				statusBar.tooltip = `Authentication failed (${detail ?? 'unknown'}). Click to sign in again.`;
				statusBar.command = 'vscode-mosayic.signIn';
				statusBar.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
				break;
			case 'error':
				statusBar.text = '$(error) Mosayic: error';
				statusBar.tooltip = `${detail ?? 'Connection error'}. Click to view logs.\nAPI: ${apiUrl}`;
				statusBar.command = 'vscode-mosayic.showOutput';
				statusBar.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
				break;
		}
		statusBar.show();
	}

	wsClient.onStateChange(renderStatus);

	// Make the output channel easy to open from the status bar
	context.subscriptions.push(
		vscode.commands.registerCommand('vscode-mosayic.showOutput', () => {
			wsClient.outputChannel.show();
		}),
	);

	// Activation trail — always visible in the output channel, so the user can
	// confirm the extension is actually running and see what state it found.
	const apiUrl = getApiUrl();
	wsClient.outputChannel.appendLine(`[${stamp()}] [info] Mosayic extension activated. API URL: ${apiUrl}`);

	void (async () => {
		const storedUrl = context.globalState.get<string>(LAST_API_URL_KEY);
		const session = await currentSession();

		if (session && storedUrl && storedUrl !== apiUrl) {
			wsClient.outputChannel.appendLine(
				`[${stamp()}] [auth] API URL changed (${storedUrl} -> ${apiUrl}). Clearing stale session.`,
			);
			const sessions = await authProvider.getSessions();
			for (const s of sessions) {
				await authProvider.removeSession(s.id);
			}
			await context.globalState.update(LAST_API_URL_KEY, undefined);
			renderStatus('signed-out');
			void vscode.window.showInformationMessage(
				`Mosayic backend changed to ${apiUrl}. Please sign in again.`,
			);
			return;
		}

		if (session) {
			wsClient.outputChannel.appendLine(`[${stamp()}] [auth] Saved session found for ${session.account.label}. Connecting WebSocket...`);
			void wsClient.connect();
		} else {
			wsClient.outputChannel.appendLine(`[${stamp()}] [auth] No saved session — WebSocket will NOT connect until you sign in. Click the status bar or run "Mosayic: Sign In".`);
			renderStatus('signed-out');
		}
	})();

	// React to auth session changes
	context.subscriptions.push(
		authProvider.onDidChangeSessions(e => {
			if ((e.added?.length ?? 0) > 0 || (e.changed?.length ?? 0) > 0) {
				void context.globalState.update(LAST_API_URL_KEY, getApiUrl());
				void wsClient.connect();
			} else if ((e.removed?.length ?? 0) > 0) {
				void context.globalState.update(LAST_API_URL_KEY, undefined);
				wsClient.disconnect();
			}
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('vscode-mosayic.signIn', async () => {
			try {
				const session = await vscode.authentication.getSession(AUTH_TYPE, [], { createIfNone: true });
				if (session) {
					vscode.window.showInformationMessage(`Signed in as ${session.account.label}`);
				}
			} catch (e: unknown) {
				const msg = e instanceof Error ? e.message : String(e);
				vscode.window.showErrorMessage(`Sign in failed: ${msg}`);
			}
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('vscode-mosayic.signOut', async () => {
			const sessions = await authProvider.getSessions();
			if (sessions.length === 0) {
				vscode.window.showInformationMessage('Not currently signed in.');
				return;
			}
			for (const session of sessions) {
				await authProvider.removeSession(session.id);
			}
			vscode.window.showInformationMessage('Signed out of Mosayic.');
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('vscode-mosayic.resetCommandPrompts', () => {
			wsClient.resetCommandPrompts();
			vscode.window.showInformationMessage('Mosayic will prompt again before running non-allowlisted commands.');
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('vscode-mosayic.switchBackend', async () => {
			const current = getEnvironment();
			interface BackendPick extends vscode.QuickPickItem {
				env: Environment;
			}
			const items: BackendPick[] = [
				{
					env: 'prod',
					label: 'Production',
					description: PROD_API_URL,
					detail: current === 'prod' ? 'Currently selected' : undefined,
				},
				{
					env: 'dev',
					label: 'Development',
					description: DEV_API_URL,
					detail: current === 'dev' ? 'Currently selected' : undefined,
				},
				{
					env: 'custom',
					label: 'Custom',
					description: 'Use the URL in mosayic.apiUrl',
					detail: current === 'custom' ? 'Currently selected' : undefined,
				},
			];
			const picked = await vscode.window.showQuickPick(items, {
				placeHolder: `Switch Mosayic backend (currently: ${current})`,
				matchOnDescription: true,
			});
			if (!picked || picked.env === current) { return; }

			await setEnvironment(picked.env);

			// Clear any session from the previous environment so we don't send
			// stale tokens to a different backend.
			const sessions = await authProvider.getSessions();
			for (const session of sessions) {
				await authProvider.removeSession(session.id);
			}

			wsClient.outputChannel.appendLine(
				`[${stamp()}] [config] Switched backend to "${picked.env}" (${getApiUrl()}). Previous session cleared — run "Mosayic: Sign In" to reconnect.`,
			);

			const signIn = 'Sign In';
			const choice = await vscode.window.showInformationMessage(
				`Mosayic backend switched to ${picked.label} (${getApiUrl()}). You'll need to sign in again.`,
				signIn,
			);
			if (choice === signIn) {
				await vscode.commands.executeCommand('vscode-mosayic.signIn');
			}
		}),
	);

	// Triggered by the dashboard's "Connect VS Code" button via
	// vscode://mosayic.vscode-mosayic/handoff?code=…&email=…&api=…. The student
	// is signed in to the dashboard already; the code is a one-time, 60-second
	// token minted for that account by the API the dashboard talks to. We
	// confirm with the student (anyone can craft a vscode:// link, so the
	// dialog names the account and says where the request came from), trade
	// the code for our own session, and the session-change handler above
	// connects the WebSocket. Any failure falls back to the classic
	// "Mosayic: Sign In" — nothing is lost, just the shortcut.
	//
	// `api` is the backend that minted the code. Only that backend can redeem
	// it, so if this VS Code is set to a different one (a dev machine left on
	// Production after a day of testing prod, say) the exchange would fail
	// with "expired" — a true statement about the wrong backend. Dashboards
	// since 2026-09-07 say which; we compare, and when the dashboard's
	// backend is one of ours (Production / Development) the confirm dialog
	// offers to switch to it. Anything else is named and refused: a crafted
	// link must not be able to point this extension at an arbitrary host.
	context.subscriptions.push(
		vscode.commands.registerCommand('vscode-mosayic.handoff', async (code?: string, emailHint?: string, apiHint?: string) => {
			const log = (message: string) => wsClient.outputChannel.appendLine(`[${stamp()}] [auth] ${message}`);
			if (!code) {
				log('Hand-off URI arrived without a code — ignoring.');
				return;
			}
			const who = emailHint || 'your Mosayic account';
			const currentEnv = getEnvironment();
			const currentApi = getApiUrl();
			const describe = (env: Environment, url: string) => `${environmentLabel(env)} (${url})`;

			// Which backend minted the code, and is it the one we're on?
			let switchTo: Exclude<Environment, 'custom'> | undefined;
			if (apiHint && !sameBackend(apiHint, currentApi)) {
				switchTo = environmentForUrl(apiHint);
				if (!switchTo) {
					log(`Hand-off refused: the dashboard talks to ${apiHint}, this VS Code is set to ${describe(currentEnv, currentApi)}.`);
					void vscode.window.showErrorMessage(
						`This Mosayic dashboard talks to ${apiHint}, but this VS Code is set to ${describe(currentEnv, currentApi)}. ` +
						'Run "Mosayic: Switch Backend…" to match it, then click Connect VS Code again.',
					);
					return;
				}
				log(`Hand-off from a ${environmentLabel(switchTo)} dashboard (${apiHint}) while set to ${describe(currentEnv, currentApi)} — offering to switch.`);
			}

			const existing = await currentSession();
			if (!switchTo && existing && emailHint && existing.account.label.toLowerCase() === emailHint.toLowerCase()) {
				log(`Hand-off for ${emailHint} — already signed in as that account on ${currentApi}; connecting.`);
				if (wsClient.state !== 'connected') {
					await wsClient.forceReconnect();
				}
				void vscode.window.showInformationMessage(`Mosayic is already signed in as ${existing.account.label}.`);
				return;
			}

			const connect = switchTo ? 'Switch and connect' : 'Connect';
			const csrfLine = 'Only continue if you just clicked "Connect VS Code" on the Mosayic dashboard.';
			let title: string;
			let detail: string;
			if (switchTo) {
				const target = describe(switchTo, apiHint ?? '');
				title = `Switch Mosayic to ${environmentLabel(switchTo)} and connect as ${who}?`;
				detail =
					`The dashboard that sent this sign-in talks to ${target}, but this VS Code is set to ${describe(currentEnv, currentApi)}. ` +
					`Connecting switches this VS Code to ${environmentLabel(switchTo)}` +
					(existing ? `, signing out ${existing.account.label} there first` : '') +
					`.\n\n${csrfLine}`;
			} else if (existing) {
				title = `Switch Mosayic to ${who}?`;
				detail = `This VS Code is signed in to Mosayic as ${existing.account.label}. Connecting switches it to ${who}.\n\n${csrfLine}`;
			} else {
				title = `Connect this VS Code to Mosayic as ${who}?`;
				detail = `The Mosayic dashboard in your browser is asking to sign this VS Code in.\n\n${csrfLine}`;
			}
			const choice = await vscode.window.showInformationMessage(title, { modal: true, detail }, connect);
			if (choice !== connect) {
				log('Hand-off declined.');
				return;
			}

			if (existing) {
				// Drop the old account's socket and its "Allow All" consent before
				// the new session arrives; the session-change handler reconnects.
				wsClient.disconnect();
			}
			if (switchTo) {
				// The stored session belongs to the old backend — clear it before
				// the URL changes, exactly as "Mosayic: Switch Backend…" does.
				for (const s of await authProvider.getSessions()) {
					await authProvider.removeSession(s.id);
				}
				await setEnvironment(switchTo);
				log(`Switched backend to "${switchTo}" (${getApiUrl()}) for the hand-off.`);
			}

			const apiUrl = getApiUrl();
			try {
				const session = await authProvider.createSessionFromHandoff(code, emailHint ?? '');
				await context.globalState.update(LAST_API_URL_KEY, apiUrl);
				log(`Hand-off complete — signed in as ${session.account.label} on ${apiUrl}.`);
				void vscode.window.showInformationMessage(`Signed in to Mosayic as ${session.account.label}.`);
			} catch (e: unknown) {
				const msg = e instanceof Error ? e.message : String(e);
				log(`Hand-off failed against ${apiUrl}: ${msg}`);
				const signIn = 'Sign in manually';
				const fallback = await vscode.window.showErrorMessage(
					`Mosayic couldn't finish the sign-in from the dashboard (backend: ${apiUrl}): ${msg}`,
					signIn,
				);
				if (fallback === signIn) {
					await vscode.commands.executeCommand('vscode-mosayic.signIn');
				}
			}
		})
	);

	// Triggered by the dashboard's "Open VS Code" button via the
	// vscode://mosayic.vscode-mosayic/wake URI. If signed in, force a fresh
	// WebSocket connection. Otherwise prompt sign-in (which connects on success).
	context.subscriptions.push(
		vscode.commands.registerCommand('vscode-mosayic.connect', async () => {
			const session = await currentSession();
			if (!session) {
				wsClient.outputChannel.appendLine(`[${stamp()}] [auth] Wake requested but no session — running sign-in.`);
				await vscode.commands.executeCommand('vscode-mosayic.signIn');
				return;
			}
			if (wsClient.state === 'connected') {
				wsClient.outputChannel.appendLine(`[${stamp()}] [conn] Wake received — already connected, ignoring.`);
				return;
			}
			await wsClient.forceReconnect();
		})
	);

	// Triggered by the dashboard's "Open VS Code" button on flows that just
	// kicked off a terminal command (e.g. EAS build) via
	// vscode://mosayic.vscode-mosayic/focus. The OS-level focus shift comes
	// from VS Code receiving the URI; this just lands the user on the
	// terminal that was just spawned.
	context.subscriptions.push(
		vscode.commands.registerCommand('vscode-mosayic.focus', () => {
			wsClient.focusLastTerminal();
		})
	);

	// Docker is checked only when ASKED — never on activation. It is needed
	// for a local Supabase, which comes much later than a student's first
	// day, so warning about it at start-up interrupted people who had no use
	// for Docker yet with a problem they couldn't act on. The step that needs
	// it asks then.
	context.subscriptions.push(
		vscode.commands.registerCommand('vscode-mosayic.checkDocker', () => {
			void runDockerPreflight(wsClient.outputChannel);
		})
	);
}

