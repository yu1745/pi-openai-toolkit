import { expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DEFAULT_COMPACTION_CONFIG, DEFAULT_TOOLKIT_CONFIG } from "../types";
import extension from "../extension-runtime";

const nativeCodexModel = {
	provider: "openai-codex",
	api: "openai-codex-responses",
	id: "gpt-5.5",
	baseUrl: "https://chatgpt.com/backend-api",
	contextWindow: 100_000,
};

function autoConfig() {
	return {
		config: {
			...DEFAULT_TOOLKIT_CONFIG,
			compaction: { ...DEFAULT_COMPACTION_CONFIG, contextManagement: "auto", artifactRoot: "/tmp" },
		},
		warnings: [],
	};
}

function makeContext(branch: unknown[] = [], currentModel = nativeCodexModel, onAuth?: () => void): never {
	return {
		model: currentModel,
		hasUI: false,
		ui: { notify: () => undefined },
		modelRegistry: {
			getApiKeyAndHeaders: async () => {
				onAuth?.();
				throw new Error("context management must not resolve hosted authentication");
			},
		},
		sessionManager: {
			getBranch: () => branch,
			getEntries: () => branch,
			getSessionId: () => "session-1",
		},
		getContextUsage: () => undefined,
	} as never;
}

function setup(config = autoConfig()) {
	const handlers = new Map<string, (event: never, ctx: never) => unknown>();
	const registered: Array<{ name: string; description: string; parameters: unknown; promptGuidelines?: string[] }> = [];
	const sent: Array<Record<string, unknown>> = [];
	let active = ["read"];
	const pi = {
		on: (name: string, handler: (event: never, ctx: never) => unknown) => handlers.set(name, handler),
		registerTool: (tool: { name: string; description: string; parameters: unknown; promptGuidelines?: string[] }) => registered.push(tool),
		getAllTools: () => registered,
		getActiveTools: () => active,
		setActiveTools: (names: string[]) => { active = names; },
		sendMessage: (message: Record<string, unknown>) => { sent.push(message); return true; },
	} as unknown as ExtensionAPI;
	extension(pi, { loadConfig: () => config } as never);
	return { handlers, registered, sent, active: () => active };
}

test("native Codex uses local context without OAuth, Alpha fetches, or hosted headers", async () => {
	const runtime = setup();
	let authCalls = 0;
	const ctx = makeContext([], nativeCodexModel, () => { authCalls += 1; });

	await runtime.handlers.get("session_start")?.({} as never, ctx);
	expect(authCalls).toBe(0);
	expect(runtime.handlers.has("before_provider_headers")).toBe(false);
	expect(runtime.active()).toEqual(["read", "new_context", "get_context_remaining", "history", "notes"]);

	const boundary = runtime.sent.find((message) => message.customType === "codex-context-window");
	const projected = await runtime.handlers.get("context")?.({
		messages: [
			{ role: "user", content: "before" },
			{ role: "custom", customType: "codex-context-window", details: boundary?.details },
			{ role: "user", content: "after" },
		],
	} as never, ctx) as { messages: Array<{ role: string; content?: string }> } | undefined;
	expect(projected?.messages.map((message) => message.content)).toEqual([undefined, "after"]);

	const rewritten = await runtime.handlers.get("before_provider_request")?.({
		payload: {
			model: nativeCodexModel.id,
			input: [
				{ type: "reasoning", encrypted_content: "native-model-state" },
				{ type: "function_call_output", call_id: "old-history", output: [{ type: "encrypted_content", encrypted_content: "legacy-hosted-output" }] },
			],
			tools: [{ type: "function", name: "history" }],
		},
	} as never, ctx) as Record<string, unknown>;
	expect(authCalls).toBe(0);
	expect(rewritten.client_metadata).toBeUndefined();
	expect(rewritten.input).toEqual([
		{ type: "reasoning", encrypted_content: "native-model-state" },
		{ type: "function_call_output", call_id: "old-history", output: "[Remote encrypted history/notes output omitted from local context]" },
	]);
	const history = (rewritten.tools as Array<Record<string, unknown>>)[0];
	expect(history.type).toBe("namespace");
	expect(JSON.stringify(history)).not.toContain('"encrypted":true');
});

test("off mode keeps context tools inactive and does not initialize a local window", async () => {
	const config = autoConfig();
	config.config.compaction.contextManagement = "off";
	const runtime = setup(config);
	await runtime.handlers.get("session_start")?.({} as never, makeContext());
	expect(runtime.active()).toEqual(["read"]);
	expect(runtime.sent).toEqual([]);
});

test("turning Context Management off deactivates its previously active tools", async () => {
	const config = autoConfig();
	const runtime = setup(config);
	const ctx = makeContext();
	await runtime.handlers.get("session_start")?.({} as never, ctx);
	expect(runtime.active()).toEqual(["read", "new_context", "get_context_remaining", "history", "notes"]);

	config.config.compaction.contextManagement = "off";
	await runtime.handlers.get("model_select")?.({ model: nativeCodexModel, source: "set" } as never, ctx);
	expect(runtime.active()).toEqual(["read"]);
});

test("native Codex model selection activates the same local tools without provider-specific gating", async () => {
	const runtime = setup();
	await runtime.handlers.get("model_select")?.({ model: nativeCodexModel, source: "set" } as never, makeContext());
	expect(runtime.active()).toEqual(["read", "new_context", "get_context_remaining", "history", "notes"]);
});
