import { mkdir, readdir, readFile, rename, rm, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { dirname, join, sep } from 'path';

/**
 * Claude's studio knowledge (0.2.22, capability `claude_knowledge`).
 *
 * The studio's Claude box runs `claude -p` on this machine. So that Claude
 * can answer "what does this button do?" or "what did the course say about
 * deep links?", a run from the studio carries `knowledge_url`: the studio's
 * own `/claude-knowledge.json`, a list of markdown files (the course and how
 * the studio works). This module keeps that pack as a Claude Code plugin with
 * one skill, `kealy-studio`, and the run gets `--plugin-dir <folder>`.
 *
 * Where it lives: the extension's own storage (VS Code's globalStorage for
 * this extension). Never the student's project and never ~/.claude, so the
 * student's code and their own Claude Code setup carry nothing of ours
 * (John, 2026-11-06), and Claude outside the studio knows nothing about it.
 *
 * What it can contain: only markdown files under the skill's folder. The
 * manifest (`.claude-plugin/plugin.json`) is written HERE, never taken from
 * the download, so a pack can't add hooks, MCP servers, agents or commands:
 * nothing in it runs. Claude reads it with a read-only rule for the folder.
 *
 * Freshness: a conditional GET (ETag) before each run, a few seconds at
 * most; offline or failing, the last good copy is used, and with none the
 * run simply goes ahead without it.
 */

const SKILL = 'kealy-studio';
const FORMAT = 1;
const FETCH_TIMEOUT_MS = 5_000;
// Mirrors the studio's scripts/claudeKnowledge.ts.
const PATH_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*(\/[A-Za-z0-9][A-Za-z0-9._-]*)*\.md$/;
const VERSION_RE = /^[a-f0-9]{8,64}$/;
const MAX_FILES = 400;
const MAX_TOTAL_BYTES = 6 * 1024 * 1024;
const MAX_DOWNLOAD_BYTES = 10 * 1024 * 1024;

interface Meta {
	url: string;
	etag: string | null;
	version: string;
}

export interface Knowledge {
	/** The plugin folder, for `--plugin-dir`. */
	pluginDir: string;
	version: string;
}

let root: string | null = null;
const inFlight = new Map<string, Promise<Knowledge | null>>();

/** Called once on activation with the extension's globalStorage path. */
export function initKnowledge(storagePath: string): void {
	root = join(storagePath, 'claude-knowledge');
}

/** The pack's URL as the backend sent it, if it's one we'd fetch. */
export function acceptableKnowledgeUrl(raw: unknown): string | undefined {
	if (typeof raw !== 'string' || raw.length > 500) { return undefined; }
	try {
		const url = new URL(raw);
		const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
		if (url.protocol === 'https:' || (url.protocol === 'http:' && local)) { return url.toString(); }
	} catch { /* not a URL */ }
	return undefined;
}

/** Validate a downloaded pack; returns its files, or why it was refused. */
export function validatePack(raw: unknown): { version: string; files: Record<string, string> } | { error: string } {
	if (!raw || typeof raw !== 'object') { return { error: 'not an object' }; }
	const pack = raw as { format?: unknown; version?: unknown; files?: unknown };
	if (pack.format !== FORMAT) { return { error: `format ${String(pack.format)}` }; }
	if (typeof pack.version !== 'string' || !VERSION_RE.test(pack.version)) { return { error: 'bad version' }; }
	if (!pack.files || typeof pack.files !== 'object') { return { error: 'no files' }; }
	const entries = Object.entries(pack.files as Record<string, unknown>);
	if (entries.length === 0 || entries.length > MAX_FILES) { return { error: `${entries.length} files` }; }
	let total = 0;
	const files: Record<string, string> = {};
	for (const [path, content] of entries) {
		if (!PATH_RE.test(path) || path.split('/').some((seg) => seg === '.' || seg === '..')) {
			return { error: `refused path ${path.slice(0, 80)}` };
		}
		if (typeof content !== 'string') { return { error: `non-text ${path}` }; }
		total += Buffer.byteLength(content, 'utf8');
		files[path] = content;
	}
	if (total > MAX_TOTAL_BYTES) { return { error: `${total} bytes` }; }
	if (!files['SKILL.md']) { return { error: 'no SKILL.md' }; }
	return { version: pack.version, files };
}

/**
 * A permission rule path for a folder, in Claude Code's form: `//` + an
 * absolute POSIX path. On Windows Claude Code normalises `C:\Users\x` to
 * `/c/Users/x` before matching.
 */
export function rulePath(folder: string, platform: NodeJS.Platform = process.platform): string {
	let p = folder;
	if (platform === 'win32') {
		p = p.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_m, drive: string) => `/${drive.toLowerCase()}`);
	}
	p = p.replace(/\/+$/, '');
	return `/${p}/**`;
}

/** The read-only tool rules a run needs to read the pack (it's outside the project). */
export function knowledgeToolRules(pluginDir: string): string[] {
	const path = rulePath(pluginDir);
	return [`Read(${path})`, `Grep(${path})`, `Glob(${path})`];
}

/** The line every run with the pack is told, so it looks there first. */
export const KNOWLEDGE_PROMPT =
	'You have the kealy-studio skill: the reference for Kealy Studio (the studio the student is using, its sheets, buttons and toolbox, the VS Code extension, the templates their project came from) and the full text of the course. For any question about how the studio works, what a lesson says, or how something in this project was set up, use that skill and read the relevant files before answering. It describes the studio as it is today; if the project on disk disagrees, trust the project and say so.';

async function readMeta(): Promise<Meta | null> {
	if (!root) { return null; }
	try {
		const meta = JSON.parse(await readFile(join(root, 'meta.json'), 'utf8')) as Meta;
		return VERSION_RE.test(meta.version) && existsSync(pluginDirFor(meta.version)) ? meta : null;
	} catch {
		return null;
	}
}

function pluginDirFor(version: string): string {
	return join(root as string, version);
}

async function writePlugin(version: string, files: Record<string, string>): Promise<string> {
	const base = root as string;
	const final = pluginDirFor(version);
	if (existsSync(final)) { return final; }
	const temp = join(base, `.tmp-${version}-${process.pid}-${Date.now()}`);
	const skillDir = join(temp, 'skills', SKILL);
	await mkdir(join(temp, '.claude-plugin'), { recursive: true });
	await writeFile(join(temp, '.claude-plugin', 'plugin.json'), JSON.stringify({
		name: SKILL,
		version: `0.0.0-${version}`,
		description: 'How Kealy Studio works, and its course. Loaded only for runs started from the studio.',
	}, null, 2));
	for (const [path, content] of Object.entries(files)) {
		const target = join(skillDir, ...path.split('/'));
		if (!target.startsWith(skillDir + sep)) { throw new Error(`path escapes the skill: ${path}`); }
		await mkdir(dirname(target), { recursive: true });
		await writeFile(target, content, 'utf8');
	}
	await rename(temp, final);
	return final;
}

/** Keep the current pack and the one before it (a run may still be reading it); drop the rest. */
async function prune(keep: string[]): Promise<void> {
	if (!root) { return; }
	try {
		for (const name of await readdir(root)) {
			if (name === 'meta.json' || keep.includes(name)) { continue; }
			await rm(join(root, name), { recursive: true, force: true });
		}
	} catch { /* best effort */ }
}

async function refresh(url: string, log: (line: string) => void): Promise<Knowledge | null> {
	if (!root) { return null; }
	await mkdir(root, { recursive: true });
	const meta = await readMeta();
	const cached = meta ? { pluginDir: pluginDirFor(meta.version), version: meta.version } : null;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
	try {
		const headers: Record<string, string> = { Accept: 'application/json' };
		if (meta?.etag && meta.url === url) { headers['If-None-Match'] = meta.etag; }
		const res = await fetch(url, { headers, signal: controller.signal });
		if (res.status === 304 && cached) { return cached; }
		if (!res.ok) {
			log(`  knowledge: ${url} answered ${res.status}${cached ? `, using ${cached.version}` : ''}`);
			return cached;
		}
		const text = await res.text();
		if (text.length > MAX_DOWNLOAD_BYTES) {
			log(`  knowledge: refused, ${text.length} bytes`);
			return cached;
		}
		const checked = validatePack(JSON.parse(text));
		if ('error' in checked) {
			log(`  knowledge: refused (${checked.error})${cached ? `, using ${cached.version}` : ''}`);
			return cached;
		}
		const pluginDir = await writePlugin(checked.version, checked.files);
		const next: Meta = { url, etag: res.headers.get('etag'), version: checked.version };
		await writeFile(join(root, 'meta.json'), JSON.stringify(next));
		if (checked.version !== meta?.version) {
			log(`  knowledge: ${checked.version} (${Object.keys(checked.files).length} files)`);
			await prune([checked.version, ...(meta ? [meta.version] : [])]);
		}
		return { pluginDir, version: checked.version };
	} catch (err) {
		log(`  knowledge: ${err instanceof Error ? err.message : String(err)}${cached ? `, using ${cached.version}` : ''}`);
		return cached;
	} finally {
		clearTimeout(timer);
	}
}

/**
 * The pack for a run, fresh if the studio can be reached, else the last good
 * copy, else null (the run goes ahead without it). Never throws.
 */
export function ensureKnowledge(url: string, log: (line: string) => void): Promise<Knowledge | null> {
	const pending = inFlight.get(url);
	if (pending) { return pending; }
	const p = refresh(url, log).finally(() => inFlight.delete(url));
	inFlight.set(url, p);
	return p;
}
