import * as vscode from 'vscode';
import { MosayicAuthenticationProvider } from './auth/authProvider';
import { UriEventHandler } from './auth/uriHandler';
import { MosayicWebSocketClient } from './ws/wsClient';
import { AUTH_TYPE } from './config';

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

	// Auto-connect WebSocket if already authenticated
	void vscode.authentication.getSession(AUTH_TYPE, [], { createIfNone: false }).then(session => {
		if (session) {
			void wsClient.connect();
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
}
