import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { executeLocalHistory, executeLocalNotes } from "./local-backend";
import {
	_localPathsTest,
	localHistoryDatabasePath,
	projectIdentityForCwd,
	projectKey,
} from "./local-paths";
import { HISTORY_SCHEMA_VERSION } from "./history-store";

const roots: string[] = [];

async function fixture() {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "toolkit-local-"));
	roots.push(root);
	const cwd = path.join(root, "project");
	const sessions = path.join(root, "sessions");
	await fs.mkdir(cwd);
	await fs.mkdir(sessions);
	const entries: any[] = [];
	return {
		ctx: {
			sessionManager: {
				getCwd: () => cwd,
				getSessionDir: () => sessions,
				getSessionId: () => "current",
				getSessionFile: () => path.join(sessions, "current.jsonl"),
				getEntries: () => entries,
			},
		} as never,
		root,
		cwd,
		sessions,
		entries,
	};
}

afterEach(async () => {
	_localPathsTest.clearProjectIdentityCache();
	for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

function runGit(cwd: string, ...args: string[]): void {
	const result = spawnSync("git", args, {
		cwd,
		shell: false,
		encoding: "utf8",
		env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
	});
	if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
}

async function gitWorktreeFixture() {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "toolkit-git-identity-"));
	roots.push(root);
	const main = path.join(root, "main");
	const linked = path.join(root, "linked");
	await fs.mkdir(main);
	runGit(main, "init", "--quiet");
	runGit(main, "config", "user.email", "test@example.invalid");
	runGit(main, "config", "user.name", "Toolkit Test");
	await fs.writeFile(path.join(main, "tracked.txt"), "main\n");
	runGit(main, "add", "tracked.txt");
	runGit(main, "commit", "--quiet", "-m", "initial");
	runGit(main, "worktree", "add", "--quiet", "-b", "linked-test", linked);
	await fs.mkdir(path.join(main, "nested", "deep"), { recursive: true });
	await fs.mkdir(path.join(linked, "nested", "deep"), { recursive: true });

	const moduleSource = path.join(root, "module-source");
	await fs.mkdir(moduleSource);
	runGit(moduleSource, "init", "--quiet");
	runGit(moduleSource, "config", "user.email", "test@example.invalid");
	runGit(moduleSource, "config", "user.name", "Toolkit Test");
	await fs.writeFile(path.join(moduleSource, "module.txt"), "module\n");
	runGit(moduleSource, "add", "module.txt");
	runGit(moduleSource, "commit", "--quiet", "-m", "module");
	runGit(main, "-c", "protocol.file.allow=always", "submodule", "add", "--quiet", moduleSource, "deps/module");
	return { root, main, linked, submodule: path.join(main, "deps", "module") };
}

function historyContext(cwd: string, sessions: string, id: string) {
	const entries: any[] = [];
	return {
		ctx: {
			sessionManager: {
				getCwd: () => cwd,
				getSessionDir: () => sessions,
				getSessionId: () => id,
				getSessionFile: () => path.join(sessions, `${id}.jsonl`),
				getEntries: () => entries,
			},
		} as never,
		entries,
	};
}

test("git project identity unifies linked worktrees and nested cwd while isolating submodules", async () => {
	const { main, linked, submodule } = await gitWorktreeFixture();
	const mainIdentity = projectIdentityForCwd(main);
	expect(mainIdentity.kind).toBe("git-common-dir");
	expect(projectIdentityForCwd(path.join(main, "nested", "deep"))).toEqual(mainIdentity);
	expect(projectIdentityForCwd(linked)).toEqual(mainIdentity);
	expect(projectIdentityForCwd(path.join(linked, "nested", "deep"))).toEqual(mainIdentity);
	const submoduleIdentity = projectIdentityForCwd(submodule);
	expect(submoduleIdentity.kind).toBe("git-common-dir");
	expect(submoduleIdentity.key).not.toBe(mainIdentity.key);
});

test("non-git cwd and failed git probes use the exact canonical-cwd hash fallback", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "toolkit-non-git-"));
	roots.push(root);
	const canonical = await fs.realpath(root);
	const expected = createHash("sha256").update(canonical).digest("hex");
	expect(projectIdentityForCwd(root)).toEqual({ kind: "canonical-cwd", key: expected });

	const { main } = await gitWorktreeFixture();
	expect(_localPathsTest.uncachedProjectIdentity(main, path.join(root, "missing-git")))
		.toEqual({ kind: "canonical-cwd", key: createHash("sha256").update(await fs.realpath(main)).digest("hex") });
});

test("linked-worktree headers share history and syncing one session root preserves another", async () => {
	const { root, main, linked, submodule } = await gitWorktreeFixture();
	const sessionsA = path.join(root, "sessions-a");
	const sessionsB = path.join(root, "sessions-b");
	await fs.mkdir(sessionsA);
	await fs.mkdir(sessionsB);
	const a = historyContext(main, sessionsA, "current-a");
	const b = historyContext(linked, sessionsB, "current-b");
	expect(projectKey(a.ctx)).toBe(projectKey(b.ctx));

	const writeSession = async (directory: string, name: string, cwd: string, text: string) => {
		const lines = [
			{ type: "session", version: 3, id: name, timestamp: "2026-01-01T00:00:00Z", cwd },
			{ type: "message", id: `${name}-item`, parentId: null, timestamp: "2026-01-01T00:00:01Z", message: { role: "user", content: text } },
		];
		await fs.writeFile(path.join(directory, `${name}.jsonl`), `${lines.map(JSON.stringify).join("\n")}\n`);
	};
	// A linked-worktree header in A's directory belongs to the same project.
	await writeSession(sessionsA, "linked-header", linked, "history-from-linked-header");
	await writeSession(sessionsA, "foreign-submodule", submodule, "history-from-submodule");
	await writeSession(sessionsB, "worktree-b", linked, "history-from-worktree-b");

	expect((await executeLocalHistory("search_contents", { query: "history-from-linked-header" }, a.ctx) as any).matches).toHaveLength(1);
	expect((await executeLocalHistory("search_contents", { query: "history-from-submodule" }, a.ctx) as any).matches).toHaveLength(0);
	expect((await executeLocalHistory("search_contents", { query: "history-from-worktree-b" }, b.ctx) as any).matches).toHaveLength(1);
	// Re-sync A. Its retained set does not mention B, but B's source root must survive.
	expect((await executeLocalHistory("search_contents", { query: "history-from-worktree-b" }, a.ctx) as any).matches).toHaveLength(1);

	const databasePath = localHistoryDatabasePath(a.ctx);
	const database = new Database(databasePath);
	const rootsInIndex = database.query("SELECT DISTINCT source_root FROM source_files ORDER BY source_root").all() as Array<{ source_root: string }>;
	expect(rootsInIndex.map((row) => row.source_root)).toContain(path.resolve(sessionsA));
	expect(rootsInIndex.map((row) => row.source_root)).toContain(path.resolve(sessionsB));
	database.close();
	await fs.rm(databasePath, { force: true });
	await fs.rm(`${databasePath}-wal`, { force: true });
	await fs.rm(`${databasePath}-shm`, { force: true });
});

test("local notes are isolated, bounded, atomic and reject traversal/symlinks", async () => {
	const { ctx, root } = await fixture();
	await executeLocalNotes("write_file", { path: "work/state.md", text: "one\ntwo" }, ctx);
	expect(await executeLocalNotes("read_file", { path: "work/state.md", start_line: -1 }, ctx))
		.toMatchObject({ file: { text: "two", startLine: 2 } });
	await Promise.all([
		executeLocalNotes("append_to_file", { path: "work/state.md", text: "A" }, ctx),
		executeLocalNotes("append_to_file", { path: "work/state.md", text: "B" }, ctx),
	]);
	expect(JSON.stringify(await executeLocalNotes("read_file", { path: "work/state.md" }, ctx))).toContain("twoAB");
	expect((await executeLocalNotes("search_contents", { query: "two" }, ctx) as any).matches).toHaveLength(1);
	await expect(executeLocalNotes("write_file", { path: "../escape", text: "x" }, ctx)).rejects.toThrow("escapes");
	const key = createHash("sha256")
		.update(path.resolve((ctx as any).sessionManager.getCwd()))
		.digest("hex");
	const notesRoot = path.join(os.homedir(), ".pi/agent/extensions/pi-openai-toolkit/context-management/notes", key);
	const listed = await executeLocalNotes("list_files_by_prefix", {}, ctx) as any;
	expect(listed.files[0].path).toBe("work/state.md");
	expect(await fs.stat(root)).toBeDefined();
	await fs.symlink(root, path.join(notesRoot, "link"));
	await expect(executeLocalNotes("write_file", { path: "link/escape", text: "x" }, ctx)).rejects.toThrow("symlink");
	await fs.rm(notesRoot, { recursive: true, force: true });
});

test("local history inherits windows through parentId and keeps sibling branches separate", async () => {
	const { ctx, entries } = await fixture();
	entries.push(
		{
			type: "custom_message", customType: "codex-context-window", id: "w1", parentId: null,
			timestamp: "2026-01-01T00:00:00Z", content: "", display: true,
			details: { protocol: 1, id: "m1", sessionId: "current", contextManagement: { protocol: 1, kind: "window", firstWindowId: "window-a", currentWindowId: "window-a", windowNumber: 0 } },
		},
		{ type: "message", id: "a", parentId: "w1", timestamp: "2026-01-01T00:00:01Z", message: { role: "user", content: "alpha" } },
		{
			type: "custom_message", customType: "codex-context-window", id: "w2", parentId: "a",
			timestamp: "2026-01-01T00:00:02Z", content: "", display: true,
			details: { protocol: 1, id: "m2", sessionId: "current", contextManagement: { protocol: 1, kind: "window", firstWindowId: "window-a", currentWindowId: "window-b", previousWindowId: "window-a", windowNumber: 1 } },
		},
		{ type: "message", id: "b", parentId: "w2", timestamp: "2026-01-01T00:00:03Z", message: { role: "assistant", content: [{ type: "text", text: "beta" }] } },
		{ type: "message", id: "fork", parentId: "a", timestamp: "2026-01-01T00:00:04Z", message: { role: "assistant", content: [{ type: "text", text: "fork alpha" }] } },
	);
	const first = await executeLocalHistory("list_items", { window_id: "window-a", recent_first: false }, ctx) as any;
	expect(first.items.map((item: any) => item.id)).toContain("fork");
	expect(first.items.map((item: any) => item.id)).not.toContain("b");
	const second = await executeLocalHistory("search_contents", { window_id: "window-b", query: "beta" }, ctx) as any;
	expect(second.matches[0].id).toBe("b");
	const read = await executeLocalHistory("read_item", { window_id: "window-b", item_id: "b", offset_chars: 1, limit_chars: 2 }, ctx) as any;
	expect(read.item.text).toBe("et");
});

test("SQLite FTS index incrementally syncs JSONL and rebuilds on schema mismatch", async () => {
	const { ctx, sessions } = await fixture();
	const file = path.join(sessions, "older.jsonl");
	const header = { type: "session", version: 3, id: "older", timestamp: "2026-01-01T00:00:00Z", cwd: (ctx as any).sessionManager.getCwd() };
	const first = { type: "message", id: "same-id", parentId: null, timestamp: "2026-01-01T00:00:01Z", message: { role: "user", content: "sqlite alpha" } };
	await fs.writeFile(file, `${JSON.stringify(header)}\n${JSON.stringify(first)}\n`);
	expect((await executeLocalHistory("search_contents", { query: "sqlite" }, ctx) as any).matches).toHaveLength(1);
	const databasePath = localHistoryDatabasePath(ctx);
	let database = new Database(databasePath);
	expect(database.query("PRAGMA user_version").get()).toEqual({ user_version: HISTORY_SCHEMA_VERSION });
	expect(database.query("SELECT entry_count FROM source_files WHERE file_path = ?").get(file)).toEqual({ entry_count: 1 });
	database.close();

	const second = { type: "message", id: "second", parentId: "same-id", timestamp: "2026-01-01T00:00:02Z", message: { role: "assistant", content: [{ type: "text", text: "sqlite beta" }, { type: "thinking", thinking: "secret" }, { type: "image", data: "base64-secret" }] } };
	await fs.appendFile(file, `${JSON.stringify(second)}\n`);
	expect((await executeLocalHistory("search_contents", { query: "beta" }, ctx) as any).matches).toHaveLength(1);
	expect((await executeLocalHistory("search_contents", { query: "base64-secret" }, ctx) as any).matches).toHaveLength(0);
	database = new Database(databasePath);
	expect(database.query("SELECT entry_count FROM source_files WHERE file_path = ?").get(file)).toEqual({ entry_count: 2 });
	database.exec("PRAGMA user_version=999");
	database.close();

	expect((await executeLocalHistory("search_contents", { query: "alpha" }, ctx) as any).matches).toHaveLength(1);
	database = new Database(databasePath);
	expect(database.query("PRAGMA user_version").get()).toEqual({ user_version: HISTORY_SCHEMA_VERSION });
	database.close();
	await fs.rm(databasePath, { force: true });
});

test("duplicate entry ids across fork files make read_item fail closed", async () => {
	const { ctx, sessions } = await fixture();
	for (const name of ["fork-a", "fork-b"]) {
		const lines = [
			{ type: "session", id: name, timestamp: "2026-01-01T00:00:00Z", cwd: (ctx as any).sessionManager.getCwd() },
			{ type: "message", id: "duplicate", parentId: null, timestamp: "2026-01-01T00:00:01Z", message: { role: "user", content: name } },
		];
		await fs.writeFile(path.join(sessions, `${name}.jsonl`), `${lines.map(JSON.stringify).join("\n")}\n`);
	}
	await expect(executeLocalHistory("read_item", { window_id: "fork-a", item_id: "duplicate" }, ctx)).resolves.toBeDefined();
	// The same explicit window remains unique; omitting or guessing another window is rejected by tool validation.
	await expect(executeLocalHistory("read_item", { window_id: "missing", item_id: "duplicate" }, ctx)).rejects.toThrow("not found");
});
