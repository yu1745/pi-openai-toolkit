import { createHash, randomUUID } from "node:crypto";
import { constants, promises as fs } from "node:fs";
import * as path from "node:path";
import { createInterface } from "node:readline";
import type { ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { canonicalPath, localSessionRoot } from "./local-paths";
import { identityFromEntries, localContextIdentity, validAgentName, type ContextAgentIdentity } from "./local-identity";
import { isRecord } from "./types";

export const MAX_SESSION_FILE_BYTES = 32 * 1024 * 1024;
export const MAX_SESSION_LINE_CHARS = 2 * 1024 * 1024;
const MAX_SOURCE_MANIFEST_BYTES = 16_384;

export type SessionSnapshot = {
	filePath: string;
	sourceRoot: string;
	sessionId: string;
	agentName: string;
	entries: SessionEntry[];
	size: number;
	mtimeMs: number;
	fromMemory: boolean;
};

type Source = ContextAgentIdentity & { filePath: string };
type SessionManager = ExtensionContext["sessionManager"];
// One process may host many SDK agents and load this module through multiple extension instances.
const SOURCES_KEY = Symbol.for("pi-openai-toolkit:history-sources:v1");
const shared = globalThis as typeof globalThis & { [SOURCES_KEY]?: Map<string, Map<string, SessionManager>> };
const liveSources = shared[SOURCES_KEY] ??= new Map<string, Map<string, SessionManager>>();
const published = new Map<string, string>();

function sourcesDirectory(ctx: ExtensionContext): string {
	return path.join(localSessionRoot(ctx), "sources");
}

/** Register exact sources rather than scanning project/global session directories. */
export async function registerLocalHistorySource(ctx: ExtensionContext): Promise<void> {
	const identity = localContextIdentity(ctx);
	let sources = liveSources.get(identity.rootSessionId);
	if (!sources) liveSources.set(identity.rootSessionId, sources = new Map());
	sources.set(identity.sessionId, ctx.sessionManager);
	const rawFile = ctx.sessionManager.getSessionFile?.();
	if (!rawFile) return;
	const filePath = canonicalPath(rawFile);
	const directory = sourcesDirectory(ctx);
	const key = createHash("sha256").update(identity.sessionId).digest("hex");
	const manifest = path.join(directory, `${key}.json`);
	const payload = JSON.stringify({ ...identity, filePath });
	if (published.get(manifest) === payload) return;
	if (Buffer.byteLength(payload) > MAX_SOURCE_MANIFEST_BYTES) throw new Error("history source metadata is too large");
	await fs.mkdir(directory, { recursive: true, mode: 0o700 });
	const stat = await fs.lstat(directory);
	if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("history sources directory is unsafe");
	const temporary = path.join(directory, `.${key}.${randomUUID()}.tmp`);
	try {
		await fs.writeFile(temporary, payload, { encoding: "utf8", mode: 0o600, flag: "wx" });
		await fs.rename(temporary, manifest);
		published.set(manifest, payload);
	} finally {
		await fs.rm(temporary, { force: true });
	}
}

export function unregisterLocalHistorySource(ctx: ExtensionContext): void {
	const identity = localContextIdentity(ctx);
	const sources = liveSources.get(identity.rootSessionId);
	sources?.delete(identity.sessionId);
	if (sources?.size === 0) liveSources.delete(identity.rootSessionId);
}

async function readManifest(file: string, rootSessionId: string): Promise<Source | undefined> {
	const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		const stat = await handle.stat();
		if (!stat.isFile() || stat.size > MAX_SOURCE_MANIFEST_BYTES) return undefined;
		const source: unknown = JSON.parse(await handle.readFile("utf8"));
		if (!isRecord(source) || source.version !== 1 || source.rootSessionId !== rootSessionId
			|| typeof source.sessionId !== "string" || !source.sessionId
			|| !validAgentName(source.agentName) || typeof source.filePath !== "string"
			|| !path.isAbsolute(source.filePath)) return undefined;
		return source as Source;
	} finally {
		await handle.close();
	}
}

async function readSessionFile(source: Source): Promise<SessionSnapshot | undefined> {
	const handle = await fs.open(source.filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		const stat = await handle.stat();
		if (!stat.isFile() || stat.size > MAX_SESSION_FILE_BYTES) return undefined;
		let sessionId: string | undefined;
		const entries: SessionEntry[] = [];
		const lines = createInterface({ input: handle.createReadStream(), crlfDelay: Infinity });
		for await (const line of lines) {
			if (!line) continue;
			if (line.length > MAX_SESSION_LINE_CHARS) return undefined;
			let value: unknown;
			try { value = JSON.parse(line); } catch { return undefined; }
			if (!isRecord(value)) return undefined;
			if (value.type === "session") {
				if (typeof value.id !== "string" || sessionId !== undefined) return undefined;
				sessionId = value.id;
			} else if (typeof value.type === "string" && typeof value.id === "string"
				&& (typeof value.parentId === "string" || value.parentId === null)
				&& typeof value.timestamp === "string") {
				entries.push(value as unknown as SessionEntry);
			}
		}
		if (sessionId !== source.sessionId) return undefined;
		const identity = identityFromEntries(sessionId, entries);
		if (identity.rootSessionId !== source.rootSessionId || identity.agentName !== source.agentName) return undefined;
		return {
			filePath: source.filePath, sourceRoot: path.dirname(source.filePath), sessionId,
			agentName: identity.agentName, entries,
			size: Number(stat.size), mtimeMs: Number(stat.mtimeMs), fromMemory: false,
		};
	} finally {
		await handle.close().catch(() => undefined);
	}
}

export async function loadSessionSnapshots(ctx: ExtensionContext): Promise<{
	snapshots: SessionSnapshot[];
	missingFiles: string[];
}> {
	await registerLocalHistorySource(ctx);
	const { rootSessionId } = localContextIdentity(ctx);
	const snapshots: SessionSnapshot[] = [];
	const retained = new Set<string>();
	for (const [id, manager] of liveSources.get(rootSessionId) ?? []) {
		const entries = manager.getEntries?.() ?? [];
		const identity = identityFromEntries(manager.getSessionId(), entries);
		// A manager can be rebound to a /new session. Never follow it across task boundaries.
		if (identity.rootSessionId !== rootSessionId || identity.sessionId !== id) continue;
		const rawFile = manager.getSessionFile?.();
		const filePath = rawFile ? canonicalPath(rawFile) : `memory:${id}`;
		retained.add(filePath);
		snapshots.push({
			filePath, sourceRoot: rawFile ? path.dirname(filePath) : "memory",
			sessionId: id, agentName: identity.agentName, entries,
			size: -1, mtimeMs: Date.now(), fromMemory: true,
		});
	}
	const missingFiles: string[] = [];
	const directory = sourcesDirectory(ctx);
	let files;
	try { files = await fs.readdir(directory, { withFileTypes: true }); }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		return { snapshots, missingFiles };
	}
	if ((await fs.lstat(directory)).isSymbolicLink()) throw new Error("history sources directory is unsafe");
	for (const item of files) {
		if (!item.isFile() || !/^[a-f0-9]{64}\.json$/.test(item.name)) continue;
		let source: Source | undefined;
		try { source = await readManifest(path.join(directory, item.name), rootSessionId); } catch { continue; }
		if (!source || retained.has(source.filePath)) continue;
		try {
			const snapshot = await readSessionFile(source);
			if (snapshot) snapshots.push(snapshot);
		} catch (error) {
			// Preserve indexed data on temporary unreadability/partial writes. Only confirmed deletion removes it.
			if ((error as NodeJS.ErrnoException).code === "ENOENT") missingFiles.push(source.filePath);
		}
	}
	return { snapshots, missingFiles };
}
