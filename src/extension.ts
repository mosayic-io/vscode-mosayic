import * as vscode from 'vscode';
import { MosayicAuthenticationProvider } from './auth/authProvider';
import { UriEventHandler } from './auth/uriHandler';
import { MosayicWebSocketClient, type WsState } from './ws/wsClient';
import {
	AUTH_TYPE,
	DEV_API_URL,
	PROD_API_URL,
	getApiUrl,
	getEnvironment,
	setEnvironment,
	type Environment,
} from './config';

// Survives a window reload — set just before openFolder, read on next
// activation to pop the post-scaffold dialog in the new workspace context.
const SCAFFOLD_NOTICE_KEY = 'mosayic.pendingScaffoldNotice';
const SCAFFOLD_NOTICE_MAX_AGE_MS = 60_000;

// Last backend URL that issued the currently stored session tokens. If the
// resolved API URL no longer matches, the session is stale (user switched
// environments) and we sign out rather than send prod tokens to dev (or vice
// versa).
const LAST_API_URL_KEY = 'mosayic.lastApiUrl';

interface PendingScaffoldNotice {
	path: string;
	timestamp: number;
}

export function activate(context: vscode.ExtensionContext) {
	const uriHandler = new UriEventHandler();
	context.subscriptions.push(vscode.window.registerUriHandler(uriHandler));

	const authProvider = new MosayicAuthenticationProvider(context, uriHandler);
	context.subscriptions.push(authProvider);

	const wsClient = new MosayicWebSocketClient(
		async () => {
			const session = await vscode.authentication.getSession(AUTH_TYPE, [], { createIfNone: false });
			return session?.accessToken;
		},
		async () => {
			const refreshed = await authProvider.refreshSession();
			return refreshed !== undefined;
		},
		(path) => {
			void context.globalState.update(SCAFFOLD_NOTICE_KEY, {
				path,
				timestamp: Date.now(),
			} satisfies PendingScaffoldNotice);
		},
	);
	context.subscriptions.push(wsClient);

	void showPendingScaffoldNotice(context);

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
	const stamp = () => new Date().toLocaleTimeString();
	wsClient.outputChannel.appendLine(`[${stamp()}] [info] Mosayic extension activated. API URL: ${apiUrl}`);

	void (async () => {
		const storedUrl = context.globalState.get<string>(LAST_API_URL_KEY);
		const session = await vscode.authentication.getSession(AUTH_TYPE, [], { createIfNone: false });

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

	// Triggered by the dashboard's "Open VS Code" button via the
	// vscode://mosayic.vscode-mosayic/wake URI. If signed in, force a fresh
	// WebSocket connection. Otherwise prompt sign-in (which connects on success).
	context.subscriptions.push(
		vscode.commands.registerCommand('vscode-mosayic.connect', async () => {
			const session = await vscode.authentication.getSession(AUTH_TYPE, [], { createIfNone: false });
			if (!session) {
				wsClient.outputChannel.appendLine(`[${stamp()}] [auth] Wake requested but no session — running sign-in.`);
				await vscode.commands.executeCommand('vscode-mosayic.signIn');
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
}

async function showPendingScaffoldNotice(context: vscode.ExtensionContext): Promise<void> {
	const pending = context.globalState.get<PendingScaffoldNotice>(SCAFFOLD_NOTICE_KEY);
	if (!pending) { return; }
	// Always clear — stale entries shouldn't keep popping a dialog.
	await context.globalState.update(SCAFFOLD_NOTICE_KEY, undefined);
	if (Date.now() - pending.timestamp > SCAFFOLD_NOTICE_MAX_AGE_MS) { return; }
	const currentWorkspace = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	if (currentWorkspace !== pending.path) { return; }
	void vscode.window.showInformationMessage(
		'Mosayic has set up your new project folder.',
		{
			modal: true,
			detail: 'VS Code is now in your project. Return to the Mosayic dashboard in your browser to continue setup.',
		},
	);
}
