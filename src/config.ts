import * as vscode from 'vscode';

export const AUTH_TYPE = 'mosayic';
export const AUTH_NAME = 'Mosayic';

export function getApiUrl(): string {
	return vscode.workspace.getConfiguration('mosayic').get<string>('apiUrl', 'http://127.0.0.1:8080');
}

/**
 * Returns true if the configured URL targets a remote host over plaintext HTTP.
 * Local addresses (127.0.0.1, localhost, ::1) are exempt.
 */
export function isInsecureRemoteUrl(url: string): boolean {
	if (!url.startsWith('http://')) {
		return false;
	}
	try {
		const host = new URL(url).hostname;
		return host !== '127.0.0.1' && host !== 'localhost' && host !== '::1';
	} catch {
		return false;
	}
}
