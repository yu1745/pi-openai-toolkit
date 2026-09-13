import { afterEach, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { localContextStatusPath, MAX_CONTEXT_STATUS_BYTES } from "./context-observer";
import { CodexContextWindowManager } from "./window-manager";

const cleanup: string[] = [];

afterEach(async () => {
	for (const target of cleanup.splice(0)) await fs.rm(target, { recursive: true, force: true });
});

test("latest status is bounded, atomic, permission-safe and content-free", async () => {
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "toolkit-context-status-"));
	cleanup.push(cwd);
	const branch: any[] = [];
	const sent: any[] = [];
	const lifecycle: Array<{ event: string; status: unknown }> = [];
	const ctx = {
		model: { contextWindow: 100_000 },
		sessionManager: {
			getCwd: () => cwd,
			getSessionId: () => "status-session",
			getBranch: () => branch,
		},
		getContextUsage: () => ({ contextWindow: 100_000, tokens: 80_000 }),
	} as never;
	const manager = new CodexContextWindowManager(
		async () => undefined,
		(event, status) => lifecycle.push({ event, status }),
	);
	const pi = { sendMessage: (message: unknown) => sent.push(message) } as never;

	manager.observeRuntime(ctx, "local", true, 10);
	manager.ensureInitialized(pi, ctx, true);
	branch.push({
		type: "custom_message", id: "window-entry", parentId: null, timestamp: "2026-01-01T00:00:00Z",
		...sent[0],
	});
	branch.push({
		type: "message", id: "usage-entry", parentId: "window-entry", timestamp: "2026-01-01T00:00:01Z",
		message: { role: "assistant", content: [{ type: "text", text: "prompt-body-must-not-leak" }], stopReason: "stop", usage: { totalTokens: 80_000 } },
	});
	manager.recordBudget(pi, ctx, true, 10);
	manager.recordNotesCheckpoint(ctx, 321);
	manager.recordRolloverRequested(ctx);
	manager.recordRolloverRefused(ctx, "notes-checkpoint-required");

	const file = localContextStatusPath(ctx);
	cleanup.push(path.dirname(file));
	const raw = await fs.readFile(file, "utf8");
	const status = JSON.parse(raw);
	expect(Buffer.byteLength(raw)).toBeLessThanOrEqual(MAX_CONTEXT_STATUS_BYTES);
	expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
	expect((await fs.stat(path.dirname(file))).mode & 0o777).toBe(0o700);
	expect(status).toMatchObject({
		protocol: 1,
		backend: "local",
		active: true,
		projectIdentity: { kind: "canonical-cwd" },
		window: { number: 0, initialized: true, restored: false },
		budget: {
			remainingTokens: 3_616,
			contextWindow: 83_616,
			thresholdPercent: 10,
			thresholdTokens: 8_361,
			reminderTriggered: true,
			fallbackTriggered: false,
		},
		notesCheckpoint: { success: true, sizeBytes: 321 },
		rollover: { requested: true, completed: false, refused: true, refusalReason: "notes-checkpoint-required" },
		restoration: { status: "initialized" },
	});
	expect(status.projectIdentity.key).toMatch(/^[a-f0-9]{64}$/);
	expect(status.sessionKey).toMatch(/^[a-f0-9]{64}$/);
	expect(raw).not.toContain(cwd);
	expect(raw).not.toContain("prompt-body-must-not-leak");
	expect(lifecycle.map((item) => item.event)).toContain("reminder");
	expect(JSON.stringify(lifecycle)).not.toContain("prompt-body-must-not-leak");

	manager.recordRolloverRequested(ctx);
	expect(await manager.startNewWindow(pi, ctx, { triggerTurn: true, trimPreviousWindow: true })).toBe(true);
	const completed = JSON.parse(await fs.readFile(file, "utf8"));
	expect(completed).toMatchObject({
		window: { number: 1 },
		notesCheckpoint: { success: false },
		rollover: { requested: true, completed: true, refused: false },
		restoration: { status: "rollover-completed" },
	});
	expect(completed.budget.remainingTokens).toBeUndefined();
	branch.push({
		type: "custom_message", id: "rollover-entry", parentId: "usage-entry", timestamp: "2026-01-01T00:00:02Z",
		...sent.at(-1),
	});
	manager.observeRuntime(ctx, "local", true, 10);
	manager.contextStatus(ctx);
	const beforeNewWindowUsage = JSON.parse(await fs.readFile(file, "utf8"));
	expect(beforeNewWindowUsage.budget.remainingTokens).toBeUndefined();
	expect(lifecycle.map((item) => item.event)).toContain("rollover-completed");
});

test("ordinary budget updates stay in memory while lifecycle and explicit queries persist", async () => {
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "toolkit-context-budget-"));
	cleanup.push(cwd);
	const branch: any[] = [];
	const sent: any[] = [];
	let tokens = 10_000;
	const ctx = {
		model: { contextWindow: 100_000 },
		sessionManager: {
			getCwd: () => cwd,
			getSessionId: () => "budget-session",
			getBranch: () => branch,
		},
		getContextUsage: () => ({ contextWindow: 100_000, tokens }),
	} as never;
	const manager = new CodexContextWindowManager(async () => undefined);
	const pi = { sendMessage: (message: unknown) => sent.push(message) } as never;
	manager.observeRuntime(ctx, "local", true, 5);
	manager.ensureInitialized(pi, ctx, true);
	branch.push({
		type: "custom_message", id: "budget-boundary", parentId: null, timestamp: "2026-01-01T00:00:00Z",
		...sent[0],
	});
	branch.push({
		type: "message", id: "budget-usage", parentId: "budget-boundary", timestamp: "2026-01-01T00:00:01Z",
		message: { role: "assistant", content: [], stopReason: "stop", usage: { totalTokens: 1 } },
	});
	const file = localContextStatusPath(ctx);
	cleanup.push(path.dirname(file));
	const beforeBudget = await fs.readFile(file, "utf8");

	manager.recordBudget(pi, ctx, true, 5);
	expect(await fs.readFile(file, "utf8")).toBe(beforeBudget);

	const queried = manager.contextStatus(ctx);
	expect(queried.budget.remainingTokens).toBe(73_616);
	const afterQuery = await fs.readFile(file, "utf8");
	expect(JSON.parse(afterQuery).budget.remainingTokens).toBe(73_616);

	tokens = 20_000;
	manager.recordBudget(pi, ctx, true, 5);
	expect(await fs.readFile(file, "utf8")).toBe(afterQuery);
	manager.recordNotesCheckpoint(ctx, 99);
	const afterCheckpoint = JSON.parse(await fs.readFile(file, "utf8"));
	expect(afterCheckpoint.budget.remainingTokens).toBe(63_616);
	expect(afterCheckpoint.notesCheckpoint).toMatchObject({ success: true, sizeBytes: 99 });
});

test("restored windows recover reminder and checkpoint status", async () => {
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "toolkit-context-restore-"));
	cleanup.push(cwd);
	const details = {
		protocol: 1,
		id: "marker-w2",
		sessionId: "restore-session",
		contextManagement: {
			protocol: 1, kind: "window", firstWindowId: "w1", currentWindowId: "w2", previousWindowId: "w1", windowNumber: 1,
		},
	};
	const branch = [
		{ type: "custom_message", id: "boundary", parentId: null, timestamp: "2026-01-01T00:00:00Z", customType: "codex-context-window", content: "window", display: true, details },
		{ type: "custom_message", id: "reminder", parentId: "boundary", timestamp: "2026-01-01T00:00:01Z", customType: "codex-context-window", content: "reminder", display: true, details: { ...details, id: "marker-reminder", contextManagement: { ...details.contextManagement, kind: "reminder" } } },
		{ type: "message", id: "notes-call", parentId: "reminder", timestamp: "2026-01-01T00:00:02Z", message: { role: "assistant", content: [{ type: "toolCall", id: "tc-notes", name: "notes", arguments: { action: "write_file" } }] } },
		{ type: "message", id: "notes-result", parentId: "notes-call", timestamp: "2026-01-01T00:00:03Z", message: { role: "toolResult", toolCallId: "tc-notes", toolName: "notes", isError: false, content: [{ type: "text", text: "not persisted in status" }], details: { contextManagement: { ok: true, file: { size_bytes: 42 } } } } },
	] as never[];
	const ctx = {
		model: { contextWindow: 100_000 },
		sessionManager: { getCwd: () => cwd, getSessionId: () => "restore-session", getBranch: () => branch },
		getContextUsage: () => undefined,
	} as never;
	const manager = new CodexContextWindowManager(async () => undefined);
	manager.observeRuntime(ctx, "remote", true, 5);
	manager.ensureInitialized({ sendMessage: () => { throw new Error("must not initialize"); } } as never, ctx, true);
	const file = localContextStatusPath(ctx);
	cleanup.push(path.dirname(file));
	const status = JSON.parse(await fs.readFile(file, "utf8"));
	expect(status).toMatchObject({
		window: { id: "w2", number: 1, initialized: false, restored: true },
		budget: { reminderTriggered: true, fallbackTriggered: false },
		notesCheckpoint: { success: true, sizeBytes: 42 },
		restoration: { status: "restored" },
	});
	expect(JSON.stringify(status)).not.toContain("not persisted in status");
});

test("observer failures never affect initialization or status queries", () => {
	const manager = new CodexContextWindowManager(async () => undefined);
	const ctx = {
		model: { contextWindow: 100_000 },
		sessionManager: {
			getCwd: () => { throw new Error("observer path unavailable"); },
			getSessionId: () => "broken-status-session",
			getBranch: () => [],
		},
		getContextUsage: () => undefined,
	} as never;
	const sent: unknown[] = [];
	expect(() => manager.observeRuntime(ctx, "local", true, 5)).not.toThrow();
	expect(() => manager.ensureInitialized({ sendMessage: (message: unknown) => sent.push(message) } as never, ctx, true)).not.toThrow();
	expect(sent).toHaveLength(1);
	expect(() => manager.contextStatus(ctx)).not.toThrow();
});
