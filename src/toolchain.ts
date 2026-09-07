/**
 * Acquiring the CLI tools a student's machine is missing — the other half of
 * `POST /system/toolchain/*`.
 *
 * The backend decides (which rung of the ladder, which version, which
 * artifact for this platform and arch, what its checksum is); this file does
 * exactly what it's told and reports progress. That split is why an upstream
 * release moving doesn't need an extension update.
 *
 * Everything here is per-user and needs no admin rights:
 *
 *   - **download** over https with progress, then **sha256 verify** against
 *     the hash the backend read from the publisher's own checksum file,
 *   - **extract** — `tar` on macOS/Linux, `tar.exe` on Windows 10 1803+ (it
 *     reads zips too), and PortableGit's 7-Zip self-extractor via `-o… -y`,
 *   - **place** — in the tool's own conventional per-user home where it has
 *     one (Windows git → `%LOCALAPPDATA%\Programs\Git`, which `shell.ts`
 *     already searches for Git Bash), otherwise one Mosayic-owned directory,
 *   - **PATH** — a marked, reversible block in `~/.zshrc` / `~/.bash_profile`,
 *     or the HKCU user Path on Windows. Never `setx`: it truncates PATH at
 *     1024 characters and has eaten people's environments for years.
 *
 * A manifest beside the managed directory records what we installed, where,
 * and from which URL — so `toolchain_remove` can be honest about what it will
 * delete, and so a tool the student installed themselves is never touched.
 */
import { spawn } from 'child_process';
import { createHash } from 'crypto';
import { cpSync, createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'fs';
import { get as httpsGet } from 'https';
import { homedir, tmpdir } from 'os';
import { delimiter, dirname, join } from 'path';
import { resolveShellChoice } from './shell';

/** What the backend asks us to check. */
export interface ProbeSpec { key: string; command: string; binary: string }
export interface ManagerSpec { name: string; command: string }

export interface ProbedTool {
	key: string;
	installed: boolean;
	version: string | null;
	path: string | null;
	/** "mosayic" when it came from our manifest, "theirs" otherwise. */
	provenance: 'mosayic' | 'theirs' | null;
}

/** The one step the backend chose. Mirrors `plan_for` in services/toolchain.py. */
export type InstallPlan =
	| { kind: 'manager'; key: string; manager: string; command: string; verify: string }
	| { kind: 'npm'; key: string; package: string; verify: string }
	| { kind: 'command'; key: string; command: string; args: string[]; poll_seconds: number; note: string; verify: string }
	| {
		kind: 'archive'; key: string; url: string; sha256: string | null;
		format: 'tar.gz' | 'zip' | '7z-sfx'; version: string;
		placement: 'mosayic' | 'programs'; dir_name: string;
		strip_components: number; bin_subdir: string; verify: string;
	};

export interface InstallResult {
	status: 'installed' | 'error';
	version?: string | null;
	path?: string | null;
	error?: string;
}

export type Progress = (text: string, extra?: { percent?: number; phase?: string }) => void;

const MANIFEST_VERSION = 1;
const PATH_BLOCK_START = '# >>> mosayic toolchain >>>';
const PATH_BLOCK_END = '# <<< mosayic toolchain <<<';

interface ManifestEntry {
	key: string;
	version: string;
	/** The directory we created and may therefore delete. */
	dir: string;
	/** What goes on PATH (dir, or dir/bin_subdir). */
	bin: string;
	url: string;
	installed_at: string;
	placement: 'mosayic' | 'programs';
}
interface Manifest { version: number; tools: Record<string, ManifestEntry> }

/** ~/.mosayic/tools — one place, so "remove Mosayic's tools" is one action. */
function managedRoot(): string {
	return join(homedir(), '.mosayic', 'tools');
}

function manifestPath(): string {
	return join(managedRoot(), 'manifest.json');
}

function readManifest(): Manifest {
	try {
		const raw = JSON.parse(readFileSync(manifestPath(), 'utf8')) as Manifest;
		if (raw && typeof raw === 'object' && raw.tools) { return raw; }
	} catch {
		// no manifest yet, or it's unreadable — either way we've installed nothing
	}
	return { version: MANIFEST_VERSION, tools: {} };
}

function writeManifest(manifest: Manifest): void {
	mkdirSync(managedRoot(), { recursive: true });
	writeFileSync(manifestPath(), JSON.stringify(manifest, null, 2) + '\n', 'utf8');
}

/** Every managed bin directory, newest last. Exported for the spawn sites. */
export function managedBinDirs(): string[] {
	const manifest = readManifest();
	return Object.values(manifest.tools)
		.map((t) => t.bin)
		.filter((dir) => typeof dir === 'string' && dir.length > 0 && existsSync(dir));
}

/**
 * `process.env` with the managed tools on PATH.
 *
 * Used by every place the extension spawns something, because a student's
 * shell profile is only re-read by a NEW shell: without this, a tool we
 * installed two seconds ago is invisible until VS Code restarts, and the
 * install looks like it failed.
 */
export function toolchainEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
	const dirs = managedBinDirs();
	if (dirs.length === 0) { return base; }
	// Windows' env keys are case-insensitive but Node's object is not, so find
	// the real key rather than assuming "PATH".
	const key = Object.keys(base).find((k) => k.toLowerCase() === 'path') ?? 'PATH';
	const current = base[key] ?? '';
	const missing = dirs.filter((dir) => !current.split(delimiter).includes(dir));
	if (missing.length === 0) { return base; }
	return { ...base, [key]: [...missing, current].filter(Boolean).join(delimiter) };
}

interface RunResult { exitCode: number | null; stdout: string; stderr: string }

/** Run a shell one-liner the way relayed commands run, with our PATH. */
function runShell(command: string, timeoutMs = 15 * 60_000, onLine?: (line: string) => void): Promise<RunResult> {
	return new Promise((resolve) => {
		const child = spawn(command, {
			shell: resolveShellChoice().shell,
			env: toolchainEnv(),
			timeout: timeoutMs,
		});
		let stdout = '';
		let stderr = '';
		const feed = (chunk: string, into: 'out' | 'err') => {
			if (into === 'out') { stdout += chunk; } else { stderr += chunk; }
			if (!onLine) { return; }
			for (const line of chunk.split(/\r?\n/)) {
				const trimmed = line.trim();
				if (trimmed) { onLine(trimmed); }
			}
		};
		child.stdout?.on('data', (d) => feed(String(d), 'out'));
		child.stderr?.on('data', (d) => feed(String(d), 'err'));
		child.on('error', (err) => resolve({ exitCode: 1, stdout, stderr: `${stderr}${err.message}` }));
		child.on('close', (code) => resolve({ exitCode: code, stdout, stderr }));
	});
}

/** The first version-shaped token in a `--version` answer. */
function parseVersion(output: string): string | null {
	const match = output.match(/\d+\.\d+(\.\d+)?/);
	return match ? match[0] : null;
}

async function whereIs(binary: string): Promise<string | null> {
	const kind = resolveShellChoice().kind;
	const command = kind === 'cmd' ? `where ${binary}` : `command -v ${binary}`;
	const result = await runShell(command, 20_000);
	if (result.exitCode !== 0) { return null; }
	const first = result.stdout.split(/\r?\n/).map((l) => l.trim()).find(Boolean);
	return first ?? null;
}

/**
 * What's on the machine, and whose it is.
 *
 * Runs the backend's own probe commands (so this and `/system/probe-tools`
 * can never disagree) plus a `--version` for each package manager, because
 * the ladder's middle rung is "use the manager they already have".
 */
export async function probeToolchain(
	tools: ProbeSpec[],
	managers: ManagerSpec[],
	log: (line: string) => void,
): Promise<{ tools: ProbedTool[]; managers: string[] }> {
	const manifest = readManifest();
	const probed = await Promise.all(tools.map(async (spec): Promise<ProbedTool> => {
		const result = await runShell(spec.command, 30_000);
		const installed = result.exitCode === 0;
		if (!installed) {
			return { key: spec.key, installed: false, version: null, path: null, provenance: null };
		}
		const path = await whereIs(spec.binary);
		const managed = manifest.tools[spec.key];
		const ours = Boolean(managed) && Boolean(path) && path!.startsWith(managed.dir);
		return {
			key: spec.key,
			installed: true,
			version: parseVersion(`${result.stdout} ${result.stderr}`),
			path,
			provenance: ours ? 'mosayic' : 'theirs',
		};
	}));
	const found = await Promise.all(managers.map(async (m) => {
		const result = await runShell(m.command, 20_000);
		return result.exitCode === 0 ? m.name : null;
	}));
	const present = found.filter((name): name is string => Boolean(name));
	log(`toolchain probe: ${probed.map((t) => `${t.key}=${t.installed ? t.version ?? 'yes' : 'no'}`).join(' ')} managers=${present.join(',') || '-'}`);
	return { tools: probed, managers: present };
}

// ── downloading ────────────────────────────────────────────────────

/** GET with redirects, to a file, reporting percent as it goes. */
function download(url: string, dest: string, onProgress: Progress, depth = 0): Promise<void> {
	return new Promise((resolve, reject) => {
		if (depth > 5) { reject(new Error('Too many redirects')); return; }
		httpsGet(url, { headers: { 'User-Agent': 'mosayic-vscode' } }, (res) => {
			const status = res.statusCode ?? 0;
			if (status >= 300 && status < 400 && res.headers.location) {
				res.resume();
				const next = new URL(res.headers.location, url).toString();
				download(next, dest, onProgress, depth + 1).then(resolve, reject);
				return;
			}
			if (status !== 200) {
				res.resume();
				reject(new Error(`The download server answered ${status}`));
				return;
			}
			const total = Number(res.headers['content-length'] ?? 0);
			let seen = 0;
			let lastReported = 0;
			const file = createWriteStream(dest);
			res.on('data', (chunk: Buffer) => {
				seen += chunk.length;
				if (!total) { return; }
				const percent = Math.floor((seen / total) * 100);
				// Every 5% — a progress event per chunk would flood the socket
				// and the dashboard for a 60MB download.
				if (percent >= lastReported + 5) {
					lastReported = percent;
					onProgress(`Downloading… ${percent}%`, { percent, phase: 'download' });
				}
			});
			res.pipe(file);
			file.on('finish', () => file.close(() => resolve()));
			file.on('error', reject);
			res.on('error', reject);
		}).on('error', reject);
	});
}

function sha256Of(file: string): Promise<string> {
	return new Promise((resolve, reject) => {
		const hash = createHash('sha256');
		const stream = createReadStream(file);
		stream.on('data', (chunk: string | Buffer) => { hash.update(chunk); });
		stream.on('end', () => resolve(hash.digest('hex')));
		stream.on('error', reject);
	});
}

/** Windows' bundled bsdtar. Present since Windows 10 1803; reads zip and tar. */
function windowsTar(): string {
	return join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');
}

function spawnDirect(command: string, args: string[], timeoutMs: number): Promise<RunResult> {
	return new Promise((resolve) => {
		const child = spawn(command, args, { env: toolchainEnv(), timeout: timeoutMs });
		let stdout = '';
		let stderr = '';
		child.stdout?.on('data', (d) => { stdout += String(d); });
		child.stderr?.on('data', (d) => { stderr += String(d); });
		child.on('error', (err) => resolve({ exitCode: 1, stdout, stderr: `${stderr}${err.message}` }));
		child.on('close', (code) => resolve({ exitCode: code, stdout, stderr }));
	});
}

/** Unpack `archive` into `into`, which is created fresh. */
async function extract(archive: string, into: string, format: string): Promise<void> {
	mkdirSync(into, { recursive: true });
	if (format === '7z-sfx') {
		// PortableGit ships as a 7-Zip self-extracting .exe: -o<dir> is the
		// destination, -y answers its prompts. No installer, no admin rights.
		const result = await spawnDirect(archive, [`-o${into}`, '-y'], 10 * 60_000);
		if (result.exitCode !== 0) {
			throw new Error(result.stderr.trim() || 'The Git archive would not unpack');
		}
		return;
	}
	if (process.platform === 'win32') {
		const result = await spawnDirect(windowsTar(), ['-xf', archive, '-C', into], 10 * 60_000);
		if (result.exitCode === 0) { return; }
		// Older Windows without bsdtar: PowerShell can do zips.
		if (format === 'zip') {
			const ps = await spawnDirect('powershell.exe', [
				'-NoProfile', '-NonInteractive', '-Command',
				`Expand-Archive -LiteralPath '${archive}' -DestinationPath '${into}' -Force`,
			], 10 * 60_000);
			if (ps.exitCode === 0) { return; }
			throw new Error(ps.stderr.trim() || 'Windows could not unpack the download');
		}
		throw new Error(result.stderr.trim() || 'Windows could not unpack the download');
	}
	const args = format === 'zip'
		? ['-q', archive, '-d', into]
		: ['-xzf', archive, '-C', into];
	const result = await spawnDirect(format === 'zip' ? 'unzip' : 'tar', args, 10 * 60_000);
	if (result.exitCode !== 0) {
		throw new Error(result.stderr.trim() || 'The download would not unpack');
	}
}

/** The single directory an archive unpacked into, for strip_components. */
function soleChild(dir: string): string {
	const entries = readdirSync(dir);
	if (entries.length === 1) {
		const only = join(dir, entries[0]);
		if (statSync(only).isDirectory()) { return only; }
	}
	return dir;
}

// ── PATH ───────────────────────────────────────────────────────────

/**
 * Rewrite the marked block in the student's shell profiles from the manifest.
 *
 * Marked and rewritten wholesale (rather than appended to) so removing a tool
 * removes its line, and so running this twice can't stack duplicates. The
 * files are the login-shell ones a GUI-launched VS Code terminal actually
 * reads; a missing file is created, because a Mac with no ~/.zshrc is normal.
 */
function writePosixPath(dirs: string[]): void {
	const body = dirs.length
		? [PATH_BLOCK_START,
		   '# Added by Mosayic. Remove this block (or run "remove Mosayic\'s tools")',
		   '# to take these off your PATH.',
		   ...dirs.map((dir) => `export PATH="${dir}:$PATH"`),
		   PATH_BLOCK_END, ''].join('\n')
		: '';
	for (const file of [join(homedir(), '.zshrc'), join(homedir(), '.bash_profile')]) {
		let existing = '';
		try { existing = readFileSync(file, 'utf8'); } catch { existing = ''; }
		const start = existing.indexOf(PATH_BLOCK_START);
		const end = existing.indexOf(PATH_BLOCK_END);
		let next: string;
		if (start >= 0 && end > start) {
			next = existing.slice(0, start) + body + existing.slice(end + PATH_BLOCK_END.length + 1);
		} else if (body) {
			next = existing + (existing.endsWith('\n') || !existing ? '' : '\n') + '\n' + body;
		} else {
			continue;
		}
		try { writeFileSync(file, next, 'utf8'); } catch { /* read-only home — PATH still works in-process */ }
	}
}

/**
 * Prepend to the HKCU user Path.
 *
 * `setx` truncates PATH at 1024 characters and is the classic way to destroy
 * someone's environment, so this goes through .NET's setter, which doesn't.
 */
async function writeWindowsPath(dirs: string[]): Promise<void> {
	if (dirs.length === 0) { return; }
	const quoted = dirs.map((d) => d.replace(/'/g, "''")).map((d) => `'${d}'`).join(',');
	const script = [
		`$want = @(${quoted})`,
		`$current = [Environment]::GetEnvironmentVariable('Path','User')`,
		`$parts = @()`,
		`if ($current) { $parts = $current -split ';' | Where-Object { $_ -ne '' } }`,
		`$missing = $want | Where-Object { $parts -notcontains $_ }`,
		`if ($missing) {`,
		`  $next = (@($missing) + $parts) -join ';'`,
		`  [Environment]::SetEnvironmentVariable('Path', $next, 'User')`,
		`}`,
	].join('; ');
	await spawnDirect('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], 60_000);
}

async function exportPath(): Promise<void> {
	const dirs = managedBinDirs();
	if (process.platform === 'win32') {
		await writeWindowsPath(dirs);
	} else {
		writePosixPath(dirs);
	}
}

// ── installing ─────────────────────────────────────────────────────

function placementRoot(placement: 'mosayic' | 'programs'): string {
	if (placement === 'programs' && process.platform === 'win32') {
		const localAppData = process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local');
		return join(localAppData, 'Programs');
	}
	return managedRoot();
}

async function verify(plan: InstallPlan): Promise<{ ok: boolean; version: string | null }> {
	const result = await runShell(plan.verify, 60_000);
	return {
		ok: result.exitCode === 0,
		version: parseVersion(`${result.stdout} ${result.stderr}`),
	};
}

async function installArchive(plan: Extract<InstallPlan, { kind: 'archive' }>, onProgress: Progress, log: (line: string) => void): Promise<InstallResult> {
	const root = placementRoot(plan.placement);
	const dest = join(root, plan.dir_name);
	if (existsSync(dest)) {
		const manifest = readManifest();
		if (!manifest.tools[plan.key]) {
			// Something is already there that we didn't put there. Installing
			// over it would take the blame for whatever breaks next.
			return { status: 'error', error: `There's already something at ${dest}. Mosayic won't overwrite it.` };
		}
		rmSync(dest, { recursive: true, force: true });
	}

	const scratch = join(tmpdir(), `mosayic-${plan.key}-${Date.now()}`);
	mkdirSync(scratch, { recursive: true });
	const suffix = plan.format === 'zip' ? '.zip' : plan.format === '7z-sfx' ? '.exe' : '.tar.gz';
	const archive = join(scratch, `${plan.key}${suffix}`);
	try {
		onProgress(`Downloading ${plan.key} ${plan.version}…`, { percent: 0, phase: 'download' });
		await download(plan.url, archive, onProgress);

		if (plan.sha256) {
			onProgress('Checking the download…', { phase: 'verify' });
			const actual = await sha256Of(archive);
			if (actual.toLowerCase() !== plan.sha256.toLowerCase()) {
				return { status: 'error', error: 'The download did not match its checksum, so Mosayic threw it away.' };
			}
		} else {
			// git-for-windows is the live example: no checksum file in the
			// release. Say so rather than implying we checked.
			log(`No published checksum for ${plan.key}; verified by HTTPS origin only.`);
		}

		onProgress('Unpacking…', { phase: 'extract' });
		if (plan.format === '7z-sfx') {
			// The self-extractor writes the tree itself; no strip needed.
			await extract(archive, dest, plan.format);
		} else {
			const unpacked = join(scratch, 'unpacked');
			await extract(archive, unpacked, plan.format);
			const source = plan.strip_components > 0 ? soleChild(unpacked) : unpacked;
			mkdirSync(dirname(dest), { recursive: true });
			try {
				renameSync(source, dest);
			} catch {
				// Different filesystems (tmp on its own volume) — fall back to a copy.
				cpSync(source, dest, { recursive: true });
			}
		}

		const bin = plan.bin_subdir ? join(dest, plan.bin_subdir) : dest;
		const manifest = readManifest();
		manifest.tools[plan.key] = {
			key: plan.key, version: plan.version, dir: dest, bin,
			url: plan.url, installed_at: new Date().toISOString(),
			placement: plan.placement,
		};
		writeManifest(manifest);

		onProgress('Putting it on your PATH…', { phase: 'path' });
		await exportPath();

		// Verify through the shell first, because that's what every later step
		// will use. If that says no, ask the binary itself before calling a
		// perfectly good install a failure: the shell answer depends on the
		// probe command, the profile and PATH, and any one of those being odd
		// on this machine is not a reason to make the student install node
		// twice. (It was exactly this: the probe sourced nvm unguarded, which
		// aborts /bin/sh on a machine that has no nvm, so a working node
		// reported "installed but still isn't running" forever.)
		const checked = await verify(plan);
		if (!checked.ok) {
			const direct = join(bin, process.platform === 'win32' ? `${plan.key}.exe` : plan.key);
			const fallback = existsSync(direct)
				? await spawnDirect(direct, ['--version'], 30_000)
				: null;
			if (!fallback || fallback.exitCode !== 0) {
				return { status: 'error', error: `${plan.key} was installed to ${dest} but still isn't running. Restart VS Code and try again.` };
			}
			log(`${plan.key} verified by running ${direct} (the shell probe didn't see it)`);
			return { status: 'installed', version: parseVersion(fallback.stdout) ?? plan.version, path: bin };
		}
		log(`installed ${plan.key} ${checked.version ?? plan.version} at ${dest}`);
		return { status: 'installed', version: checked.version ?? plan.version, path: bin };
	} finally {
		try { rmSync(scratch, { recursive: true, force: true }); } catch { /* best effort */ }
	}
}

async function installViaShell(command: string, plan: InstallPlan, onProgress: Progress): Promise<InstallResult> {
	onProgress('Working…', { phase: 'install' });
	const result = await runShell(command, 20 * 60_000, (line) => onProgress(line, { phase: 'install' }));
	const checked = await verify(plan);
	if (checked.ok) {
		return { status: 'installed', version: checked.version, path: await whereIs(plan.key) };
	}
	const tail = (result.stderr || result.stdout).trim().split(/\r?\n/).slice(-3).join(' ');
	return { status: 'error', error: tail || `That didn't install ${plan.key}.` };
}

/**
 * Fire a GUI installer and watch for the result.
 *
 * `xcode-select --install` returns immediately: the work happens in Apple's
 * own dialog and its Software Update download, which we can neither drive nor
 * see. So the process exit means nothing and we poll the probe instead —
 * which is also what tells us the student clicked Cancel.
 */
async function installViaCommand(plan: Extract<InstallPlan, { kind: 'command' }>, onProgress: Progress): Promise<InstallResult> {
	if (plan.note) { onProgress(plan.note, { phase: 'install' }); }
	await spawnDirect(plan.command, plan.args, 60_000);
	const deadline = Date.now() + plan.poll_seconds * 1000;
	let announced = false;
	while (Date.now() < deadline) {
		const checked = await verify(plan);
		if (checked.ok) {
			return { status: 'installed', version: checked.version, path: await whereIs(plan.key) };
		}
		if (!announced) {
			announced = true;
			onProgress('Waiting for the install to finish…', { phase: 'install' });
		}
		await new Promise((r) => setTimeout(r, 5_000));
	}
	return { status: 'error', error: `${plan.key} still isn't here. If you closed the installer, click Install again.` };
}

export async function installTool(plan: InstallPlan, onProgress: Progress, log: (line: string) => void): Promise<InstallResult> {
	log(`toolchain install: ${plan.key} via ${plan.kind}`);
	try {
		switch (plan.kind) {
			case 'archive':
				return await installArchive(plan, onProgress, log);
			case 'manager':
				return await installViaShell(plan.command, plan, onProgress);
			case 'npm':
				return await installViaShell(`npm install -g ${plan.package}`, plan, onProgress);
			case 'command':
				return await installViaCommand(plan, onProgress);
			default:
				return { status: 'error', error: 'Mosayic does not know how to install that.' };
		}
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		log(`toolchain install failed: ${plan.key}: ${message}`);
		return { status: 'error', error: message };
	}
}

/** Delete a tool we installed. Refuses anything that isn't ours. */
export async function removeManagedTool(key: string, log: (line: string) => void): Promise<{ status: string; error?: string }> {
	const manifest = readManifest();
	const entry = manifest.tools[key];
	if (!entry) {
		return { status: 'not_managed' };
	}
	try {
		rmSync(entry.dir, { recursive: true, force: true });
	} catch (err) {
		return { status: 'error', error: err instanceof Error ? err.message : String(err) };
	}
	delete manifest.tools[key];
	writeManifest(manifest);
	await exportPath();
	log(`removed ${key} from ${entry.dir}`);
	return { status: 'removed' };
}

/** Everything Mosayic installed, for the dashboard's Machine page. */
export function managedTools(): ManifestEntry[] {
	return Object.values(readManifest().tools);
}
