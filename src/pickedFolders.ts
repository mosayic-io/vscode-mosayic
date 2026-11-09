import type * as vscode from 'vscode';
import { realpathSync } from 'fs';

/**
 * Folders the student chose in VS Code's own folder picker (the `pick_folder`
 * message). They count as allowed roots for the backend's file and folder
 * requests, alongside the home folder and the open workspace.
 *
 * Why: on Windows plenty of people keep projects outside their profile
 * (`C:\rn\my-app`, `D:\dev\...`). The picker happily returned `C:\rn`, the
 * clone into it ran (shell commands aren't path-guarded), and then the very
 * next read of the new app's app.json was refused as "outside allowed
 * directories" — every scaffold outside $HOME failed at the naming step
 * (2026-11-09, ofentsenglazi). The guard is there so a compromised backend
 * can't point us at a folder the student never chose; a folder they picked
 * by hand in VS Code's own dialog is exactly one they chose.
 *
 * Kept in globalState so a reload or an update doesn't forget it. Capped so
 * the list can't grow without bound.
 */
const KEY = 'mosayic.pickedFolders';
const MAX = 50;

let store: vscode.Memento | undefined;

export function initPickedFolders(globalState: vscode.Memento): void {
	store = globalState;
}

export function pickedFolders(): string[] {
	const saved = store?.get<string[]>(KEY) ?? [];
	const roots: string[] = [];
	for (const p of saved) {
		try {
			roots.push(realpathSync(p));
		} catch {
			// gone or unreadable — skip it, keep the rest
		}
	}
	return roots;
}

export function rememberPickedFolder(path: string): void {
	if (!store) { return; }
	let real: string;
	try {
		real = realpathSync(path);
	} catch {
		return;
	}
	const saved = (store.get<string[]>(KEY) ?? []).filter(p => p !== real);
	saved.unshift(real);
	void store.update(KEY, saved.slice(0, MAX));
}
