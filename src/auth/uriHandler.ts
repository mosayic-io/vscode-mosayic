import * as vscode from 'vscode';

export class UriEventHandler extends vscode.EventEmitter<vscode.Uri> implements vscode.UriHandler {
	handleUri(uri: vscode.Uri): vscode.ProviderResult<void> {
		if (uri.path === '/sign-in') {
			vscode.commands.executeCommand('vscode-mosayic.signIn');
			return;
		}
		if (uri.path === '/handoff') {
			// The dashboard's "Connect VS Code" button: a one-time sign-in code
			// minted for whoever is signed in to the dashboard, their email as
			// a display hint for the confirm dialog, and (dashboards since
			// 2026-09-07) the API the dashboard talks to — the backend that
			// minted the code, which is the only one that can redeem it.
			const query = new URLSearchParams(uri.query);
			vscode.commands.executeCommand(
				'vscode-mosayic.handoff',
				query.get('code') ?? '',
				query.get('email') ?? '',
				query.get('api') ?? '',
			);
			return;
		}
		if (uri.path === '/wake') {
			vscode.commands.executeCommand('vscode-mosayic.connect');
			return;
		}
		if (uri.path === '/focus') {
			vscode.commands.executeCommand('vscode-mosayic.focus');
			return;
		}
		this.fire(uri);
	}
}
