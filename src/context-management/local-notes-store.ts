import { constants, promises as fs } from "node:fs";
import * as path from "node:path";
import { createInterface } from "node:readline";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { localNotesRoot, safeOptionalPrefix, safeRelativePath } from "./local-paths";
import type { NotesAction } from "./types";

export const MAX_NOTE_BYTES = 1_000_000;
export const MAX_NOTE_RESULT_BYTES = 200_000;
const MAX_NOTE_FILES = 1_000;
const queues = new Map<string, Promise<unknown>>();

type NoteFile = {
	relative: string;
	full: string;
	stat: Awaited<ReturnType<typeof fs.stat>>;
};

function bounded(value: unknown, fallback: number, maximum: number): number {
	return typeof value === "number" && Number.isInteger(value) && value > 0
		? Math.min(value, maximum)
		: fallback;
}

async function ensureSafeParent(root: string, relative: string): Promise<string> {
	await fs.mkdir(root, { recursive: true, mode: 0o700 });
	const parts = relative.split("/");
	let current = root;
	for (const part of parts.slice(0, -1)) {
		current = path.join(current, part);
		try {
			const stat = await fs.lstat(current);
			if (stat.isSymbolicLink() || !stat.isDirectory()) {
				throw new Error("notes path contains a symlink or non-directory parent");
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			await fs.mkdir(current, { mode: 0o700 });
			const stat = await fs.lstat(current);
			if (stat.isSymbolicLink() || !stat.isDirectory()) {
				throw new Error("notes parent changed while it was being created");
			}
		}
	}
	return path.join(root, ...parts);
}

async function openRegularNoFollow(file: string) {
	const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
	const stat = await handle.stat();
	if (!stat.isFile()) {
		await handle.close();
		throw new Error("notes path is not a regular file");
	}
	if (stat.size > MAX_NOTE_BYTES) {
		await handle.close();
		throw new Error(`note exceeds ${MAX_NOTE_BYTES} bytes`);
	}
	return { handle, stat };
}

async function listFiles(ctx: ExtensionContext): Promise<NoteFile[]> {
	const root = localNotesRoot(ctx);
	await fs.mkdir(root, { recursive: true, mode: 0o700 });
	const output: NoteFile[] = [];
	async function walk(directory: string): Promise<void> {
		if (output.length >= MAX_NOTE_FILES) return;
		for (const item of await fs.readdir(directory, { withFileTypes: true })) {
			if (output.length >= MAX_NOTE_FILES || item.isSymbolicLink()) continue;
			const full = path.join(directory, item.name);
			if (item.isDirectory()) await walk(full);
			else if (item.isFile()) {
				const stat = await fs.stat(full);
				if (stat.size <= MAX_NOTE_BYTES) {
					output.push({
						relative: path.relative(root, full).split(path.sep).join("/"),
						full,
						stat,
					});
				}
			}
		}
	}
	await walk(root);
	return output;
}

async function readBounded(file: string): Promise<string> {
	const { handle, stat } = await openRegularNoFollow(file);
	try {
		const buffer = Buffer.alloc(Number(stat.size));
		await handle.read(buffer, 0, buffer.length, 0);
		return buffer.toString("utf8");
	} finally {
		await handle.close();
	}
}

function sliceLines(text: string, startValue: unknown, stopValue: unknown) {
	const lines = text.split("\n");
	const totalLines = lines.length;
	const resolve = (value: unknown, fallback: number) =>
		typeof value === "number" && Number.isInteger(value)
			? value < 0 ? totalLines + value + 1 : value
			: fallback;
	const startLine = Math.max(1, Math.min(totalLines, resolve(startValue, 1)));
	const stopLine = Math.max(startLine, Math.min(totalLines, resolve(stopValue, totalLines)));
	let result = lines.slice(startLine - 1, stopLine).join("\n");
	if (Buffer.byteLength(result) > MAX_NOTE_RESULT_BYTES) {
		result = Buffer.from(result).subarray(0, MAX_NOTE_RESULT_BYTES).toString("utf8");
	}
	return { text: result, startLine, stopLine, totalLines };
}

async function writeAtomic(root: string, relative: string, text: string): Promise<number> {
	const bytes = Buffer.byteLength(text);
	if (bytes > MAX_NOTE_BYTES) throw new Error(`note exceeds ${MAX_NOTE_BYTES} bytes`);
	const file = await ensureSafeParent(root, relative);
	const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
	const handle = await fs.open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
	try {
		await handle.writeFile(text, "utf8");
		await handle.sync();
	} finally {
		await handle.close();
	}
	try {
		// Revalidate immediately before publication. O_NOFOLLOW protects the opened
		// temporary/read files; this second parent walk narrows directory-swap TOCTOU.
		if (await ensureSafeParent(root, relative) !== file) {
			throw new Error("notes path changed before atomic publication");
		}
		await fs.rename(temporary, file);
	} catch (error) {
		await fs.rm(temporary, { force: true });
		throw error;
	}
	return bytes;
}

async function searchFile(file: NoteFile, query: string, limit: number) {
	const { handle } = await openRegularNoFollow(file.full);
	const matches: Array<{ line: number; text: string }> = [];
	try {
		const lines = createInterface({ input: handle.createReadStream(), crlfDelay: Infinity });
		let line = 0;
		for await (const text of lines) {
			line += 1;
			if (text.includes(query)) matches.push({ line, text: text.slice(0, 4_000) });
			if (matches.length >= limit) break;
		}
	} finally {
		await handle.close().catch(() => undefined);
	}
	return matches;
}

export async function executeLocalNotes(
	action: NotesAction,
	params: Record<string, unknown>,
	ctx: ExtensionContext,
): Promise<Record<string, unknown>> {
	const root = localNotesRoot(ctx);
	if (action === "list_files_by_prefix" || action === "search_contents") {
		let files = await listFiles(ctx);
		const prefix = safeOptionalPrefix(action === "list_files_by_prefix" ? params.prefix : params.path_prefix);
		files = files.filter((file) => !prefix || file.relative.startsWith(prefix));
		const descending = action === "search_contents"
			? params.recent_file_first !== false
			: params.file_order === "descending";
		const orderBy = action === "list_files_by_prefix" ? params.file_order_by : "updated_at";
		files.sort((left, right) => {
			const order = orderBy === "name"
				? left.relative.localeCompare(right.relative)
				: orderBy === "created_at"
					? Number(left.stat.birthtimeMs) - Number(right.stat.birthtimeMs)
					: Number(left.stat.mtimeMs) - Number(right.stat.mtimeMs);
			return descending ? -order : order;
		});
		if (action === "list_files_by_prefix") {
			return {
				files: files.slice(0, bounded(params.max_results, 100, MAX_NOTE_FILES)).map((file) => ({
					path: file.relative,
					size_bytes: file.stat.size,
					created_at: file.stat.birthtime.toISOString(),
					updated_at: file.stat.mtime.toISOString(),
				})),
			};
		}
		const matches = [];
		const perFile = bounded(params.max_matches_per_file, 100, 1_000);
		for (const file of files.slice(0, bounded(params.max_files, 100, MAX_NOTE_FILES))) {
			const found = await searchFile(file, String(params.query), perFile);
			if (found.length > 0) matches.push({ path: file.relative, matches: found });
		}
		return { matches };
	}

	const relative = safeRelativePath(params.path, "notes path");
	const file = await ensureSafeParent(root, relative);
	if (action === "read_file") {
		return { file: { path: relative, ...sliceLines(await readBounded(file), params.start_line, params.stop_line) } };
	}

	const text = String(params.text ?? "");
	const operation = async () => {
		let next = text;
		if (action === "append_to_file") {
			try {
				next = await readBounded(file) + text;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
		}
		const size = await writeAtomic(root, relative, next);
		return { ok: true, file: { path: relative, size_bytes: size } };
	};
	const previous = queues.get(file) ?? Promise.resolve();
	const current = previous.then(operation, operation);
	queues.set(file, current);
	try {
		return await current;
	} finally {
		if (queues.get(file) === current) queues.delete(file);
	}
}

export async function loadLocalThreadHint(ctx: ExtensionContext): Promise<string | undefined> {
	const files = await listFiles(ctx);
	files.sort((left, right) => Number(right.stat.mtimeMs) - Number(left.stat.mtimeMs));
	if (files.length === 0) return undefined;
	return `<local_notes_hint>Recent notes: ${files.slice(0, 5).map((file) => file.relative).join(", ")}</local_notes_hint>`;
}
