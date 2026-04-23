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
 * Pick the shell to hand to Node's ``child_process.spawn({ shell })`` on the
 * current platform.
 *
 * On macOS/Linux we return ``true`` (spawn picks ``/bin/sh``).
 *
 * On Windows we never return the bare string ``"bash"`` or ``"pwsh"``: Node
 * resolves those via a PATH lookup, and on a machine with the "Windows
 * Subsystem for Linux" optional feature enabled, ``C:\Windows\System32\bash.exe``
 * is the WSL distro launcher — not a POSIX bash. Commands would then run
 * inside the user's Ubuntu distro, where none of their Windows-installed CLI
 * tools (gh.exe, npm.cmd, supabase.exe, ...) exist. Instead we resolve
 * Git Bash / PowerShell to known absolute install paths and fall back to
 * cmd.exe (``true``, which honours ``%ComSpec%``). cmd resolves .exe/.cmd/.ps1
 * via PATHEXT, which covers every CLI the Mosayic backend invokes.
 */
export function resolveCommandShell(): string | boolean {
	if (process.platform !== 'win32') { return true; }

	const pref = getWindowsShellPreference();

	if (pref === 'cmd' || pref === 'auto') { return true; }

	if (pref === 'gitbash') {
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
		// Never fall back to a PATH lookup for "bash" — that's the WSL trap.
		return true;
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
