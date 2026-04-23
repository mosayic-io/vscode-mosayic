import * as vscode from 'vscode';
import { spawn } from 'child_process';
import { resolveCommandShell } from './shell';

const DOCKER_INSTALL_URL = 'https://www.docker.com/products/docker-desktop/';
const DOCKER_PROBE_TIMEOUT_MS = 3000;

export type DockerPreflightResult =
	| { state: 'ok'; version: string }
	| { state: 'not-installed' }
	| { state: 'daemon-down'; detail?: string }
	| { state: 'unknown'; detail?: string };

/**
 * Probe the local Docker installation. Deliberately does NOT try to install
 * Docker — Docker Desktop installation on Windows needs UAC, EULA, WSL2
 * enablement, reboot, and a first-run GUI wizard, none of which we can
 * reliably automate. The user installs it themselves; we just tell them
 * what state they're in.
 */
export async function checkDocker(): Promise<DockerPreflightResult> {
	return new Promise((resolve) => {
		const child = spawn('docker info --format "{{.ServerVersion}}"', {
			shell: resolveCommandShell(),
			timeout: DOCKER_PROBE_TIMEOUT_MS,
		});

		let stdout = '';
		let stderr = '';
		child.stdout?.on('data', (c: Buffer) => { stdout += c.toString(); });
		child.stderr?.on('data', (c: Buffer) => { stderr += c.toString(); });

		child.on('error', (err) => {
			resolve({ state: 'unknown', detail: err.message });
		});

		child.on('close', (code) => {
			const exit = code ?? 1;
			const outTrim = stdout.trim();
			const errTrim = stderr.trim();
			const errLower = errTrim.toLowerCase();

			if (exit === 0 && outTrim.length > 0) {
				resolve({ state: 'ok', version: outTrim });
				return;
			}

			// cmd.exe: "'docker' is not recognized as an internal or external command"
			// sh:      "docker: command not found" (exit 127)
			if (
				exit === 127 ||
				errLower.includes('not recognized') ||
				errLower.includes('command not found') ||
				errLower.includes('not found')
			) {
				resolve({ state: 'not-installed' });
				return;
			}

			// Docker CLI is present but the daemon isn't reachable. On macOS/Linux
			// the error is "Cannot connect to the Docker daemon at unix://..."; on
			// Windows it's about the npipe ("open //./pipe/docker_engine: ...").
			if (
				errLower.includes('cannot connect') ||
				errLower.includes('pipe') ||
				errLower.includes('docker daemon')
			) {
				resolve({ state: 'daemon-down', detail: errTrim });
				return;
			}

			resolve({ state: 'unknown', detail: errTrim || outTrim });
		});
	});
}

// Surface the warning at most once per extension session (until VS Code
// reloads), unless the user explicitly runs the check command.
let warnedThisSession = false;

export function resetDockerPreflightSessionWarning(): void {
	warnedThisSession = false;
}

/**
 * Run the Docker preflight and optionally surface a notification. Safe to
 * fire-and-forget from extension activation — never throws, never blocks.
 *
 * @param output  Channel to log the outcome to (for the "Mosayic: Show Logs" flow).
 * @param manual  True when the user explicitly invoked the check command —
 *                 shows success/unknown notifications that are suppressed on
 *                 the passive startup probe.
 */
export async function runDockerPreflight(
	output: vscode.OutputChannel,
	opts: { manual?: boolean } = {},
): Promise<void> {
	const stamp = () => new Date().toLocaleTimeString();
	const manual = opts.manual === true;

	let result: DockerPreflightResult;
	try {
		result = await checkDocker();
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		output.appendLine(`[${stamp()}] [docker] Preflight failed: ${msg}`);
		return;
	}

	switch (result.state) {
		case 'ok':
			output.appendLine(`[${stamp()}] [docker] OK (Server ${result.version})`);
			if (manual) {
				void vscode.window.showInformationMessage(
					`Docker is running (Server ${result.version}).`,
				);
			}
			return;

		case 'not-installed': {
			output.appendLine(`[${stamp()}] [docker] Not installed`);
			if (!manual && warnedThisSession) { return; }
			warnedThisSession = true;
			const install = 'Install Docker Desktop';
			const recheck = 'Re-check';
			const choice = await vscode.window.showWarningMessage(
				'Mosayic needs Docker to run Supabase locally, but Docker Desktop was not found on your machine.',
				install,
				recheck,
			);
			if (choice === install) {
				void vscode.env.openExternal(vscode.Uri.parse(DOCKER_INSTALL_URL));
			} else if (choice === recheck) {
				void runDockerPreflight(output, { manual: true });
			}
			return;
		}

		case 'daemon-down': {
			output.appendLine(
				`[${stamp()}] [docker] Daemon not running${result.detail ? `: ${result.detail}` : ''}`,
			);
			if (!manual && warnedThisSession) { return; }
			warnedThisSession = true;
			const recheck = 'Re-check';
			const choice = await vscode.window.showWarningMessage(
				'Docker is installed but not running. Start Docker Desktop, then click Re-check.',
				recheck,
			);
			if (choice === recheck) {
				void runDockerPreflight(output, { manual: true });
			}
			return;
		}

		case 'unknown': {
			output.appendLine(
				`[${stamp()}] [docker] Unknown state${result.detail ? `: ${result.detail}` : ''}`,
			);
			if (manual) {
				void vscode.window.showWarningMessage(
					'Unable to determine Docker status. See Mosayic output for details.',
				);
			}
			return;
		}
	}
}
