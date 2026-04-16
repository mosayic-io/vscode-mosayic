import * as vscode from 'vscode';

export const AUTH_TYPE = 'mosayic';
export const AUTH_NAME = 'Mosayic';

export function getApiUrl(): string {
	return vscode.workspace.getConfiguration('mosayic').get<string>('apiUrl', 'http://127.0.0.1:8090');
}

export type ConfirmMode = 'allowlisted' | 'always' | 'never';

export function getConfirmMode(): ConfirmMode {
	const raw = vscode.workspace.getConfiguration('mosayic').get<string>('confirmCommands', 'allowlisted');
	// Backwards compat: old boolean values may still be in user settings
	if (raw === 'true' || (raw as unknown) === true) { return 'always'; }
	if (raw === 'false' || (raw as unknown) === false) { return 'never'; }
	if (raw === 'allowlisted' || raw === 'always' || raw === 'never') { return raw; }
	return 'allowlisted';
}

/**
 * Command prefixes that Mosayic is expected to send from the dashboard.
 * Commands starting with any of these are auto-approved in "allowlisted" mode.
 * The list is intentionally conservative — only read-only or standard
 * Mosayic-workflow commands belong here.
 */
const ALLOWED_PREFIXES = [
	// GitHub CLI
	'gh ',
	// Firebase CLI
	'firebase ',
	// Google Cloud CLI
	'gcloud ',
	// Expo / React Native
	'expo ',
	'npx expo ',
	'eas ',
	'npx eas ',
	// Supabase CLI
	'supabase ',
	'npx supabase ',
	// Node / npm (for project setup)
	'npm ',
	'npx ',
	'node ',
	// Project scaffolding
	'mkdir ',
	'git ',
	'unzip ',
	'sed ',
];

export function isAllowlistedCommand(command: string): boolean {
	const trimmed = command.trimStart();
	return ALLOWED_PREFIXES.some(prefix => trimmed.startsWith(prefix));
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
