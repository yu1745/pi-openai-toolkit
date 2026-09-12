import { constants, promises as fs } from "node:fs";
import * as path from "node:path";
import { createInterface } from "node:readline";
import type { ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { canonicalPath, projectIdentityForCwd, projectKey } from "./local-paths";
import { isRecord } from "./types";

export const MAX_SESSION_FILE_BYTES = 32 * 1024 * 1024;
export const MAX_SESSION_LINE_CHARS = 2 * 1024 * 1024;

export type SessionSnapshot = {
	filePath: string;
	/** Canonical session directory used to scope deletion in the shared project index. */
	sourceRoot: string;
	sessionId: string;
	entries: SessionEntry[];
	size: number;
	mtimeMs: number;
	fromMemory: boolean;
};

async function readSessionFile(
	filePath: string,
	sourceRoot: string,
	expectedProjectKey: string,
): Promise<SessionSnapshot | undefined> {
	const handle = await fs.open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		const stat = await handle.stat();
		if (!stat.isFile() || stat.size > MAX_SESSION_FILE_BYTES) return undefined;
		let sessionId: string | undefined;
		let sessionProjectKey: string | undefined;
		const entries: SessionEntry[] = [];
		const lines = createInterface({ input: handle.createReadStream(), crlfDelay: Infinity });
		for await (const line of lines) {
			if (line.length === 0) continue;
			if (line.length > MAX_SESSION_LINE_CHARS) return undefined;
			let value: unknown;
			try {
				value = JSON.parse(line);
			} catch {
				// A trailing partial line may be concurrently appended. Other malformed
				// data makes this snapshot unsafe to index.
				return undefined;
			}
			if (!isRecord(value)) return undefined;
			if (value.type === "session") {
				if (typeof value.id !== "string" || typeof value.cwd !== "string") return undefined;
				sessionId = value.id;
				sessionProjectKey = projectIdentityForCwd(value.cwd).key;
			} else if (
				typeof value.type === "string"
				&& typeof value.id === "string"
				&& (typeof value.parentId === "string" || value.parentId === null)
				&& typeof value.timestamp === "string"
			) {
				entries.push(value as unknown as SessionEntry);
			}
		}
		if (!sessionId || sessionProjectKey !== expectedProjectKey) return undefined;
		return { filePath, sourceRoot, sessionId, entries, size: Number(stat.size), mtimeMs: Number(stat.mtimeMs), fromMemory: false };
	} finally {
		await handle.close().catch(() => undefined);
	}
}

export async function loadSessionSnapshots(ctx: ExtensionContext): Promise<SessionSnapshot[]> {
	const configuredSessionDir = path.resolve(ctx.sessionManager.getSessionDir());
	const configuredStat = await fs.lstat(configuredSessionDir);
	if (configuredStat.isSymbolicLink()) throw new Error("session directory must not be a symlink");
	const sessionDir = canonicalPath(configuredSessionDir);
	const expectedProjectKey = projectKey(ctx);
	const directoryStat = await fs.lstat(sessionDir);
	if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
		throw new Error("session directory is not a safe directory");
	}
	const currentFileRaw = ctx.sessionManager.getSessionFile();
	const currentFile = currentFileRaw
		? canonicalPath(currentFileRaw)
		: `memory:${sessionDir}:${ctx.sessionManager.getSessionId()}`;
	if (currentFileRaw && path.dirname(currentFile) !== sessionDir) {
		throw new Error("current session file is outside sessionManager.getSessionDir()");
	}
	const snapshots: SessionSnapshot[] = [{
		filePath: currentFile,
		sourceRoot: sessionDir,
		sessionId: ctx.sessionManager.getSessionId(),
		entries: ctx.sessionManager.getEntries(),
		size: -1,
		mtimeMs: Date.now(),
		fromMemory: true,
	}];
	for (const item of await fs.readdir(sessionDir, { withFileTypes: true })) {
		if (!item.isFile() || item.isSymbolicLink() || !item.name.endsWith(".jsonl")) continue;
		const candidate = path.join(sessionDir, item.name);
		const canonical = canonicalPath(candidate);
		if (path.dirname(canonical) !== sessionDir || canonical === currentFile) continue;
		try {
			const snapshot = await readSessionFile(canonical, sessionDir, expectedProjectKey);
			if (snapshot) snapshots.push(snapshot);
		} catch {
			// Concurrent deletion and unsafe files are ignored. The next sync retries.
		}
	}
	return snapshots;
}
