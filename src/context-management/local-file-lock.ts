import { createHash } from "node:crypto";
import { constants, promises as fs } from "node:fs";
import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const LOCK_WAIT_MS = 5_000;

/** Serialize a whole read-modify-publish operation across Pi processes. */
export async function withLocalFileLock<T>(
	directory: string,
	key: string,
	operation: () => Promise<T>,
	signal?: AbortSignal,
): Promise<T> {
	await fs.mkdir(directory, { recursive: true, mode: 0o700 });
	const stat = await fs.lstat(directory);
	if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("notes lock directory is unsafe");
	const file = path.join(directory, `${createHash("sha256").update(key).digest("hex")}.lock`);
	const deadline = Date.now() + LOCK_WAIT_MS;
	let handle;
	while (!handle) {
		signal?.throwIfAborted();
		try {
			handle = await fs.open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			if (Date.now() >= deadline) {
				throw new Error("notes write lock timed out; another process is writing or a stale lock needs operator cleanup");
			}
			await delay(25, undefined, { signal });
		}
	}
	try {
		// Diagnostic ownership only. Never steal a lock by age/PID: doing so races a live writer.
		await handle.writeFile(JSON.stringify({ pid: process.pid }), "utf8");
		signal?.throwIfAborted();
		return await operation();
	} finally {
		try { await handle.close(); }
		finally { await fs.unlink(file); }
	}
}
