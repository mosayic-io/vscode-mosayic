import * as vscode from 'vscode';
import { existsSync } from 'fs';

export type WindowsShellPreference = 'auto' | 'cmd' | 'gitbash' | 'pwsh';

function getWindowsShellPreference(): WindowsShellPreference {
	const raw = vscode.workspace
		.getConfiguration('mosayic')
		.get<string>('windowsShell', 'auto');
	if (raw === 'auto' || raw === 'cmd' || raw === 'gitbash' || raw === 'pwsh') {
		return raw;
	}
	return 'auto';
}

/**
 * Locate Git Bash at its known install paths. Never falls back to a PATH
 * lookup for "bash": on a machine with the "Windows Subsystem for Linux"
 * optional feature enabled, ``C:\Windows\System32\bash.exe`` is the WSL
 * distro launcher — not a POSIX bash. Commands would then run inside the
 * user's Ubuntu distro, where none of their Windows-installed CLI tools
 * (gh.exe, npm.cmd, supabase.exe, ...) exist.
 */
function findGitBash(): string | null {
	const envOverride = process.env.MOSAYIC_GIT_BASH;
	const candidates = [
		envOverride,
		'C:\\Program Files\\Git\\bin\\bash.exe',
		'C:\\Program Files\\Git\\usr\\bin\\bash.exe',
		'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
	].filter((c): c is string => typeof c === 'string' && c.length > 0);
	for (const c of candidates) {
		if (existsSync(c)) { return c; }
	}
	return null;
}

/**
 * Pick the shell to hand to Node's ``child_process.spawn({ shell })`` on the
 * current platform.
 *
 * On macOS/Linux we return ``true`` (spawn picks ``/bin/sh``).
 *
 * On Windows, ``auto`` prefers Git Bash: the commands the Mosayic backend
 * relays are POSIX one-liners (`&&` chains, `$(...)`, `[ -f ... ]`,
 * `mkdir -p`), which cmd.exe cannot parse — and the course has every Windows
 * student install Git Bash before they reach any Mosayic-driven step. Only
 * when Git Bash genuinely isn't installed do we fall back to cmd.exe
 * (``true``, which honours ``%ComSpec%``). PowerShell resolves to known
 * absolute install paths for the same WSL-trap reason as Git Bash.
 */
export function resolveCommandShell(): string | boolean {
	if (process.platform !== 'win32') { return true; }

	const pref = getWindowsShellPreference();

	if (pref === 'cmd') { return true; }

	if (pref === 'auto' || pref === 'gitbash') {
		return findGitBash() ?? true;
	}

	if (pref === 'pwsh') {
		const candidates = [
			'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
			'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
		];
		for (const c of candidates) {
			if (existsSync(c)) { return c; }
		}
		return true;
	}

	return true;
}
