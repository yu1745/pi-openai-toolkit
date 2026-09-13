import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CONFIG_DIR } from "../config";
import { executeLocalHistory, executeLocalNotes } from "./local-backend";
import { checkpointLocalHistory } from "./history-service";
import { registerLocalHistorySource, unregisterLocalHistorySource } from "./history-source";
import { CONTEXT_AGENT_IDENTITY_ENTRY, localContextIdentity } from "./local-identity";
import {
	_localPathsTest, localHistoryDatabasePath, localNotesRoot, localSessionRoot,
	projectIdentityForCwd, projectKey,
} from "./local-paths";
import { HISTORY_SCHEMA_VERSION } from "./history-store";

const roots = new Set<string>();
const contexts: ExtensionContext[] = [];

async function fixture(options: { rootSessionId?: string; agentName?: string; cwd?: string; memory?: boolean } = {}) {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "toolkit-local-"));
	roots.add(root);
	const cwd = options.cwd ?? path.join(root, "project");
	const sessions = path.join(root, "sessions");
	await fs.mkdir(cwd, { recursive: true });
	await fs.mkdir(sessions);
	const id = randomUUID();
	const entries: any[] = [];
	if (options.rootSessionId) entries.push({
		type: "custom", id: "identity", parentId: null, timestamp: "2026-01-01T00:00:00Z",
		customType: CONTEXT_AGENT_IDENTITY_ENTRY,
		data: { version: 1, sessionId: id, rootSessionId: options.rootSessionId, agentName: options.agentName },
	});
	const file = options.memory ? undefined : path.join(sessions, `${id}.jsonl`);
	const ctx = { sessionManager: {
		getCwd: () => cwd, getSessionDir: () => sessions, getSessionId: () => id,
		getSessionFile: () => file, getEntries: () => entries,
	} } as unknown as ExtensionContext;
	contexts.push(ctx);
	roots.add(localSessionRoot(ctx));
	const persist = async () => {
		if (!file) throw new Error("in-memory fixture");
		await fs.writeFile(file, [
			JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-01-01T00:00:00Z", cwd }),
			...entries.map((entry) => JSON.stringify(entry)), "",
		].join("\n"));
	};
	return { ctx, root, cwd, sessions, entries, id, file, persist };
}

afterEach(async () => {
	for (const ctx of contexts.splice(0)) unregisterLocalHistorySource(ctx);
	_localPathsTest.clearProjectIdentityCache();
	for (const root of roots) await fs.rm(root, { recursive: true, force: true });
	roots.clear();
});

function message(id: string, text: string, parentId: string | null = null) {
	return { type: "message", id, parentId, timestamp: "2026-01-01T00:00:01Z", message: { role: "user", content: text } };
}

function window(id: string, sessionId: string) {
	return {
		type: "custom_message", customType: "codex-context-window", id: "boundary", parentId: null,
		timestamp: "2026-01-01T00:00:00Z", content: "", display: true,
		details: { protocol: 1, id: "marker", sessionId, contextManagement: {
			protocol: 1, kind: "window", firstWindowId: id, currentWindowId: id, windowNumber: 0,
		} },
	};
}

function runGit(cwd: string, ...args: string[]): void {
	const result = spawnSync("git", args, { cwd, shell: false, encoding: "utf8", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
	if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
}

async function gitWorktreeFixture() {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "toolkit-git-identity-"));
	roots.add(root);
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
	return { main, linked, submodule: path.join(main, "deps", "module") };
}

test("diagnostic project identity still unifies worktrees and nested cwd, not submodules", async () => {
	const { main, linked, submodule } = await gitWorktreeFixture();
	const identity = projectIdentityForCwd(main);
	expect(identity.kind).toBe("git-common-dir");
	expect(projectIdentityForCwd(path.join(main, "nested", "deep"))).toEqual(identity);
	expect(projectIdentityForCwd(linked)).toEqual(identity);
	expect(projectIdentityForCwd(path.join(linked, "nested", "deep"))).toEqual(identity);
	expect(projectIdentityForCwd(submodule).key).not.toBe(identity.key);
});

test("non-git cwd and failed probes retain canonical-cwd diagnostic identity", async () => {
	const { root } = await fixture();
	const expected = createHash("sha256").update(await fs.realpath(root)).digest("hex");
	expect(projectIdentityForCwd(root)).toEqual({ kind: "canonical-cwd", key: expected });
	const { main } = await gitWorktreeFixture();
	expect(_localPathsTest.uncachedProjectIdentity(main, path.join(root, "missing-git"))).toEqual({
		kind: "canonical-cwd", key: createHash("sha256").update(await fs.realpath(main)).digest("hex"),
	});
});

test("separate sessions in the same project do not share notes or history", async () => {
	const a = await fixture();
	const b = await fixture({ cwd: a.cwd });
	expect(projectKey(a.ctx)).toBe(projectKey(b.ctx));
	expect(localSessionRoot(a.ctx)).not.toBe(localSessionRoot(b.ctx));
	await executeLocalNotes("write_file", { path: "state.md", text: "session A" }, a.ctx);
	expect((await executeLocalNotes("list_files_by_prefix", {}, b.ctx) as any).files).toHaveLength(0);
	await expect(executeLocalNotes("read_file", { path: "/root/notes/state.md" }, b.ctx)).rejects.toThrow();
	a.entries.push(message("a", "only-in-a"));
	await registerLocalHistorySource(a.ctx);
	expect((await executeLocalHistory("search_contents", { query: "only-in-a", agent_name: "/root" }, b.ctx) as any).matches).toHaveLength(0);
	// Unrelated JSONL in the caller's directory is not a source discovery mechanism.
	await fs.writeFile(path.join(b.sessions, "unrelated.jsonl"), `${JSON.stringify({ type: "session", id: a.id, cwd: a.cwd })}\n${JSON.stringify(message("foreign", "foreign-history"))}\n`);
	expect((await executeLocalHistory("search_contents", { query: "foreign-history" }, b.ctx) as any).matches).toHaveLength(0);
});

test("worktrees share task state only through explicit identity, not project identity", async () => {
	const { main, linked } = await gitWorktreeFixture();
	const parent = await fixture({ cwd: main });
	const independent = await fixture({ cwd: linked });
	const child = await fixture({ cwd: linked, rootSessionId: parent.id, agentName: "/root/worker" });
	expect(localSessionRoot(parent.ctx)).not.toBe(localSessionRoot(independent.ctx));
	expect(localSessionRoot(parent.ctx)).toBe(localSessionRoot(child.ctx));
	await executeLocalNotes("write_file", { path: "state.md", text: "child state" }, child.ctx);
	expect((await executeLocalNotes("read_file", { path: "/root/worker/notes/state.md" }, parent.ctx) as any).file.text).toBe("child state");
});

test("relative notes default to the current agent; absolute paths cross agents within the task", async () => {
	const parent = await fixture();
	const child = await fixture({ rootSessionId: parent.id, agentName: "/root/worker" });
	const nested = await fixture({ rootSessionId: parent.id, agentName: "/root/worker/deep" });
	for (const [item, text] of [[parent, "parent"], [child, "child"], [nested, "nested"]] as const) {
		await executeLocalNotes("write_file", { path: "state.md", text }, item.ctx);
		expect((await executeLocalNotes("read_file", { path: "state.md" }, item.ctx) as any).file.text).toBe(text);
	}
	const listed = await executeLocalNotes("list_files_by_prefix", {}, child.ctx) as any;
	expect(listed.files.map((file: any) => file.path)).toEqual(["/root/worker/notes/state.md"]);
	expect((await executeLocalNotes("search_contents", { query: "parent" }, child.ctx) as any).matches).toHaveLength(0);
	expect((await executeLocalNotes("search_contents", { query: "parent", path_prefix: "/root/notes" }, child.ctx) as any).matches).toHaveLength(1);
	await executeLocalNotes("append_to_file", { path: "/root/worker/notes/state.md", text: " shared" }, parent.ctx);
	expect((await executeLocalNotes("read_file", { path: "state.md" }, child.ctx) as any).file.text).toBe("child shared");
});

test("notes virtual path validation, line slicing, queueing, and symlink containment", async () => {
	const { ctx, root } = await fixture();
	await executeLocalNotes("write_file", { path: "work/state.md", text: "one\ntwo" }, ctx);
	expect(await executeLocalNotes("read_file", { path: "work/state.md", start_line: -1 }, ctx)).toMatchObject({ file: { text: "two", startLine: 2 } });
	await Promise.all([
		executeLocalNotes("append_to_file", { path: "work/state.md", text: "A" }, ctx),
		executeLocalNotes("append_to_file", { path: "/root/notes/work/state.md", text: "B" }, ctx),
	]);
	expect((await executeLocalNotes("read_file", { path: "work/state.md" }, ctx) as any).file.text).toBe("one\ntwoAB");
	for (const invalid of ["../escape", "a/../b", "a//b", "./x", "a\\b", "/etc/passwd", "/root/notes", "/root//notes/x", "x\0y"]) {
		await expect(executeLocalNotes("write_file", { path: invalid, text: "x" }, ctx)).rejects.toThrow();
	}
	await executeLocalNotes("write_file", { path: "~/literal.md", text: "literal tilde" }, ctx);
	await fs.symlink(root, path.join(localNotesRoot(ctx), "link"));
	await expect(executeLocalNotes("write_file", { path: "link/escape", text: "x" }, ctx)).rejects.toThrow("symlink");
	await expect(executeLocalNotes("read_file", { path: "link/escape" }, ctx)).rejects.toThrow("symlink");
});

test("separate processes append to the same cross-agent note without losing writes", async () => {
	const parent = await fixture();
	await executeLocalNotes("write_file", { path: "shared.md", text: "" }, parent.ctx);
	const modulePath = new URL("./local-notes-store.ts", import.meta.url).pathname;
	const run = (agent: string) => {
		const id = randomUUID();
		const metadata = { version: 1, sessionId: id, rootSessionId: parent.id, agentName: `/root/${agent}` };
		const script = `import { executeLocalNotes } from ${JSON.stringify(modulePath)};
		const ctx = { sessionManager: { getSessionId: () => ${JSON.stringify(id)}, getEntries: () => [{ type: 'custom', customType: 'context-management-agent-identity', data: ${JSON.stringify(metadata)} }] } };
		for (let i = 0; i < 12; i++) await executeLocalNotes('append_to_file', { path: '/root/notes/shared.md', text: ${JSON.stringify(agent)} + i + '\\n' }, ctx);`;
		return Bun.spawn([process.execPath, "--eval", script], { stdout: "pipe", stderr: "pipe" });
	};
	const children = [run("a"), run("b")];
	for (const child of children) {
		const stderr = await new Response(child.stderr).text();
		expect({ code: await child.exited, stderr }).toEqual({ code: 0, stderr: "" });
	}
	const result = await executeLocalNotes("read_file", { path: "shared.md" }, parent.ctx) as any;
	const lines = result.file.text.trim().split("\n");
	expect(lines).toHaveLength(24);
	expect(new Set(lines).size).toBe(24);
});

test("an aborted lock waiter neither writes nor steals another owner's lock", async () => {
	const { ctx } = await fixture();
	await executeLocalNotes("write_file", { path: "locked.md", text: "before" }, ctx);
	const key = createHash("sha256").update("root/notes/locked.md").digest("hex");
	const lock = path.join(localSessionRoot(ctx), "locks", `${key}.lock`);
	await fs.writeFile(lock, JSON.stringify({ pid: process.pid }));
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 50);
	try {
		await expect(executeLocalNotes("append_to_file", { path: "locked.md", text: "after" }, ctx, controller.signal)).rejects.toThrow();
	} finally {
		clearTimeout(timer);
	}
	expect((await executeLocalNotes("read_file", { path: "locked.md" }, ctx) as any).file.text).toBe("before");
	expect(await fs.stat(lock)).toBeDefined();
});

test("old project-scoped notes remain untouched and are not automatically imported", async () => {
	const { ctx } = await fixture();
	const legacy = path.join(CONFIG_DIR, "context-management", "notes", projectKey(ctx));
	roots.add(legacy);
	await fs.mkdir(legacy, { recursive: true });
	await fs.writeFile(path.join(legacy, "old.md"), "old project note");
	expect((await executeLocalNotes("list_files_by_prefix", {}, ctx) as any).files).toHaveLength(0);
	await executeLocalNotes("write_file", { path: "old.md", text: "new task note" }, ctx);
	expect(await fs.readFile(path.join(legacy, "old.md"), "utf8")).toBe("old project note");
});

test("history agent defaults and relative/absolute names apply to every action including read_item", async () => {
	const parent = await fixture();
	const child = await fixture({ rootSessionId: parent.id, agentName: "/root/worker" });
	const nested = await fixture({ rootSessionId: parent.id, agentName: "/root/worker/deep" });
	for (const item of [parent, child, nested]) {
		item.entries.push(window("same-window", item.id), message("duplicate", `text-${localContextIdentity(item.ctx).agentName}`, "boundary"));
		await registerLocalHistorySource(item.ctx);
	}
	const read = (ctx: ExtensionContext, agent_name?: string) => executeLocalHistory("read_item", { item_id: "duplicate", window_id: "same-window", agent_name }, ctx) as Promise<any>;
	expect((await read(parent.ctx)).item.text).toBe("text-/root");
	expect((await read(parent.ctx, "worker")).item.text).toBe("text-/root/worker");
	expect((await read(child.ctx, "deep")).item.text).toBe("text-/root/worker/deep");
	expect((await read(nested.ctx, "/root")).item.text).toBe("text-/root");
	await expect(read(parent.ctx, "missing")).rejects.toThrow("not found");
	await expect(read(parent.ctx, "../worker")).rejects.toThrow("agent_name");
	const windows = await executeLocalHistory("list_windows", {}, child.ctx) as any;
	expect(windows.windows.every((row: any) => row.agent_name === "/root/worker")).toBe(true);
	const items = await executeLocalHistory("list_items", { role: "user", agent_name: "worker" }, parent.ctx) as any;
	expect(items.items).toHaveLength(1);
	expect(items.items[0].agent_name).toBe("/root/worker");
	expect((await executeLocalHistory("search_contents", { query: "deep", agent_name: "/root/worker/deep" }, parent.ctx) as any).matches).toHaveLength(1);
	expect((await executeLocalHistory("search_contents", { query: "deep" }, parent.ctx) as any).matches).toHaveLength(0);
});

test("history search is case-sensitive literal substring, not token-only FTS", async () => {
	const { ctx, entries } = await fixture();
	entries.push(message("one", "Alpha abc_def 中文片段 100% 'quoted'"));
	for (const query of ["pha", "bc_d", "文片", "100%", "'quoted'"]) {
		expect((await executeLocalHistory("search_contents", { query }, ctx) as any).matches).toHaveLength(1);
	}
	expect((await executeLocalHistory("search_contents", { query: "alpha" }, ctx) as any).matches).toHaveLength(0);
});

test("persisted same-task sources in different directories survive restart and schema rebuild", async () => {
	const parent = await fixture();
	const child = await fixture({ rootSessionId: parent.id, agentName: "/root/child" });
	child.entries.push(message("same-id", "sqlite alpha"));
	await child.persist();
	await registerLocalHistorySource(child.ctx);
	unregisterLocalHistorySource(child.ctx); // Simulate the child host having shut down.
	const search = (query: string) => executeLocalHistory("search_contents", { query, agent_name: "child" }, parent.ctx) as Promise<any>;
	expect((await search("alpha")).matches).toHaveLength(1);
	child.entries.push(message("second", "sqlite beta"));
	await child.persist();
	expect((await search("beta")).matches).toHaveLength(1);
	const databasePath = localHistoryDatabasePath(parent.ctx);
	let database = new Database(databasePath);
	expect(database.query("PRAGMA user_version").get()).toEqual({ user_version: HISTORY_SCHEMA_VERSION });
	database.exec("PRAGMA user_version=999");
	database.close();
	expect((await search("alpha")).matches).toHaveLength(1);
	database = new Database(databasePath);
	expect(database.query("SELECT DISTINCT agent_name FROM entries WHERE file_path = ?").all(child.file!)).toEqual([{ agent_name: "/root/child" }]);
	database.close();
	await fs.rm(child.file!);
	expect((await search("beta")).matches).toHaveLength(0);
});

test("history waits for a competing SQLite writer without deleting the database", async () => {
	const item = await fixture();
	item.entries.push(message("kept", "kept history"));
	await executeLocalHistory("list_items", {}, item.ctx);
	const databasePath = localHistoryDatabasePath(item.ctx);
	const before = await fs.stat(databasePath);
	const script = `import { Database } from 'bun:sqlite';
	const db = new Database(${JSON.stringify(databasePath)});
	db.exec('BEGIN IMMEDIATE'); console.log('locked');
	await new Promise(resolve => setTimeout(resolve, 250)); db.exec('COMMIT'); db.close();`;
	const child = Bun.spawn([process.execPath, "--eval", script], { stdout: "pipe", stderr: "pipe" });
	const reader = child.stdout.getReader();
	const first = await reader.read();
	expect(new TextDecoder().decode(first.value)).toContain("locked");
	reader.releaseLock();
	expect((await executeLocalHistory("search_contents", { query: "kept history" }, item.ctx) as any).matches).toHaveLength(1);
	expect(await child.exited).toBe(0);
	expect((await fs.stat(databasePath)).ino).toBe(before.ino);
});

test("a corrupt database error does not automatically delete or replace the file", async () => {
	const { ctx } = await fixture();
	const file = localHistoryDatabasePath(ctx);
	await fs.mkdir(path.dirname(file), { recursive: true });
	await fs.writeFile(file, "not a sqlite database");
	await expect(executeLocalHistory("list_items", {}, ctx)).rejects.toThrow();
	expect(await fs.readFile(file, "utf8")).toBe("not a sqlite database");
});

test("live in-memory agents are searchable and their final indexed snapshot survives shutdown", async () => {
	const parent = await fixture();
	const child = await fixture({ memory: true, rootSessionId: parent.id, agentName: "/root/ephemeral" });
	child.entries.push(message("live", "live child"));
	await registerLocalHistorySource(child.ctx);
	const query = { query: "live child", agent_name: "ephemeral" };
	expect((await executeLocalHistory("search_contents", query, parent.ctx) as any).matches).toHaveLength(1);
	await checkpointLocalHistory(child.ctx);
	unregisterLocalHistorySource(child.ctx);
	expect((await executeLocalHistory("search_contents", query, parent.ctx) as any).matches).toHaveLength(1);
});

test("history preserves window ancestry and omits opaque/image contents", async () => {
	const { ctx, entries, id } = await fixture();
	entries.push(window("window-a", id), message("a", "alpha", "boundary"), {
		...window("window-b", id), id: "boundary-b", parentId: "a",
	}, message("b", "beta", "boundary-b"), message("fork", "fork alpha", "a"));
	const first = await executeLocalHistory("list_items", { window_id: "window-a" }, ctx) as any;
	expect(first.items.map((item: any) => item.id)).toContain("fork");
	expect(first.items.map((item: any) => item.id)).not.toContain("b");
	expect(await executeLocalHistory("read_item", { window_id: "window-b", item_id: "b", offset_chars: 1, limit_chars: 2 }, ctx)).toMatchObject({ item: { text: "et" } });
	entries.push({ type: "message", id: "opaque", parentId: "b", timestamp: "2026-01-01T00:00:02Z", message: { role: "assistant", content: [
		{ type: "thinking", thinking: "secret-thinking" }, { type: "image", data: "base64-secret" },
	] } });
	expect((await executeLocalHistory("search_contents", { query: "secret" }, ctx) as any).matches).toHaveLength(0);
});
