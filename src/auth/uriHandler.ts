import * as vscode from 'vscode';

export class UriEventHandler extends vscode.EventEmitter<vscode.Uri> implements vscode.UriHandler {
	handleUri(uri: vscode.Uri): vscode.ProviderResult<void> {
		if (uri.path === '/sign-in') {
			vscode.commands.executeCommand('vscode-mosayic.signIn');
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
