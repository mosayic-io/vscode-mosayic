import * as vscode from 'vscode';
import { MosayicAuthenticationProvider } from './auth/authProvider';
import { UriEventHandler } from './auth/uriHandler';
import { MosayicWebSocketClient, type WsState } from './ws/wsClient';
import { AUTH_TYPE, getApiUrl } from './config';

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

	void vscode.authentication.getSession(AUTH_TYPE, [], { createIfNone: false }).then(session => {
		if (session) {
			wsClient.outputChannel.appendLine(`[${stamp()}] [auth] Saved session found for ${session.account.label}. Connecting WebSocket...`);
			void wsClient.connect();
		} else {
			wsClient.outputChannel.appendLine(`[${stamp()}] [auth] No saved session — WebSocket will NOT connect until you sign in. Click the status bar or run "Mosayic: Sign In".`);
			renderStatus('signed-out');
		}
	});

	// React to auth session changes
	context.subscriptions.push(
		authProvider.onDidChangeSessions(e => {
			if ((e.added?.length ?? 0) > 0 || (e.changed?.length ?? 0) > 0) {
				void wsClient.connect();
			} else if ((e.removed?.length ?? 0) > 0) {
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
}
