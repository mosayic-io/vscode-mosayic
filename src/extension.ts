import * as vscode from 'vscode';

export function activate(context: vscode.ExtensionContext) {
	console.log('Extension "vscode-mosayic" is now active.');

	const disposable = vscode.commands.registerCommand('vscode-mosayic.helloWorld', () => {
		vscode.window.showInformationMessage('Hello from Mosayic!');
	});

	context.subscriptions.push(disposable);
}

export function deactivate() {}
