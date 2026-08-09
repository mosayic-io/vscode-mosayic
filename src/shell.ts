import * as vscode from 'vscode';
import { existsSync } from 'fs';
import { join } from 'path';

export type WindowsShellPreference = 'auto' | 'cmd' | 'gitbash' | 'pwsh';

/** Which shell we actually resolved. ``posix`` is macOS/Linux (spawn picks
 *  /bin/sh); the rest are the Windows possibilities. */
export type ShellKind = 'posix' | 'gitbash' | 'pwsh' | 'cmd';

export interface ShellChoice {
	/** The value to hand to ``child_process.spawn({ shell })``. */
	shell: string | boolean;
	kind: ShellKind;
	/**
	 * True when we WANTED a POSIX shell (preference ``auto``/``gitbash``) but
	 * couldn't find one and fell back to cmd.exe. The backend relays POSIX
	 * one-liners, so this state means most Mosayic actions will fail — the
	 * caller is expected to say so out loud rather than let commands die with
	 * inscrutable syntax errors.
	 */
	fellBackToCmd: boolean;
}

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
 *
 * Covers BOTH install scopes. The system-wide "Program Files" install is only
 * available to someone with admin rights; Git for Windows' "install for me
 * only" option, winget and scoop all land under the user profile instead, and
 * missing those meant a student with a perfectly good Git Bash silently got
 * cmd.exe — which cannot parse anything the backend sends.
 */
function findGitBash(): string | null {
	const localAppData = process.env.LOCALAPPDATA;
	const userProfile = process.env.USERPROFILE;
	const candidates = [
		process.env.MOSAYIC_GIT_BASH,
		'C:\\Program Files\\Git\\bin\\bash.exe',
		'C:\\Program Files\\Git\\usr\\bin\\bash.exe',
		'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
		// Per-user installs: Git for Windows "only for me", and winget.
		localAppData && join(localAppData, 'Programs', 'Git', 'bin', 'bash.exe'),
		localAppData && join(localAppData, 'Programs', 'Git', 'usr', 'bin', 'bash.exe'),
		// scoop keeps a "current" junction pointing at the active version.
		userProfile && join(userProfile, 'scoop', 'apps', 'git', 'current', 'bin', 'bash.exe'),
	].filter((c): c is string => typeof c === 'string' && c.length > 0);
	for (const c of candidates) {
		if (existsSync(c)) { return c; }
	}
	return null;
}

function findPowerShell(): string | null {
	const candidates = [
		'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
		'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
	];
	for (const c of candidates) {
		if (existsSync(c)) { return c; }
	}
	return null;
}

/**
 * Pick the shell to hand to Node's ``child_process.spawn({ shell })`` on the
 * current platform, along with enough context for the caller to warn about a
 * bad outcome.
 *
 * On macOS/Linux we return ``true`` (spawn picks ``/bin/sh``).
 *
 * On Windows, ``auto`` prefers Git Bash: the commands the Mosayic backend
 * relays are POSIX one-liners (`&&` chains, `$(...)`, `[ -f ... ]`,
 * `mkdir -p`, and `node -e '<js>'` whose body is POSIX-quoted), which cmd.exe
 * cannot parse — and the course has every Windows student install Git Bash
 * before they reach any Mosayic-driven step. Only when Git Bash genuinely
 * isn't installed do we fall back to cmd.exe (``true``, which honours
 * ``%ComSpec%``). PowerShell resolves to known absolute install paths for the
 * same WSL-trap reason as Git Bash.
 */
export function resolveShellChoice(): ShellChoice {
	if (process.platform !== 'win32') {
		return { shell: true, kind: 'posix', fellBackToCmd: false };
	}

	const pref = getWindowsShellPreference();

	if (pref === 'cmd') {
		return { shell: true, kind: 'cmd', fellBackToCmd: false };
	}

	if (pref === 'pwsh') {
		const pwsh = findPowerShell();
		return pwsh
			? { shell: pwsh, kind: 'pwsh', fellBackToCmd: false }
			: { shell: true, kind: 'cmd', fellBackToCmd: true };
	}

	// 'auto' | 'gitbash'
	const bash = findGitBash();
	return bash
		? { shell: bash, kind: 'gitbash', fellBackToCmd: false }
		: { shell: true, kind: 'cmd', fellBackToCmd: true };
}

/** Thin wrapper for callers that only need the spawn argument. */
export function resolveCommandShell(): string | boolean {
	return resolveShellChoice().shell;
}
