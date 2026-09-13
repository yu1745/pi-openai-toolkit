import { expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DEFAULT_COMPACTION_CONFIG, DEFAULT_TOOLKIT_CONFIG } from "../types";
import extension from "../extension-runtime";

const nativeCodexModel = {
	provider: "openai-codex",
	api: "openai-codex-responses",
	id: "gpt-5.6-sol",
	baseUrl: "https://chatgpt.com/backend-api",
	contextWindow: 100_000,
};
const unlistedNativeCodexModel = { ...nativeCodexModel, id: "gpt-5.5" };
const otherProviderModel = {
	provider: "openai",
	api: "openai-responses",
	id: "gpt-5.5",
	baseUrl: "https://api.openai.com/v1",
	contextWindow: 100_000,
};

function autoConfig() {
	return {
		config: {
			...DEFAULT_TOOLKIT_CONFIG,
			compaction: {
				...DEFAULT_COMPACTION_CONFIG,
				contextManagement: "auto",
				gatewayContextModels: ["openai-codex/gpt-5.6-sol", "openai-codex/gpt-6-astra"],
				artifactRoot: "/tmp",
			},
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
				return {
					ok: true,
					apiKey: "test-token",
					headers: { "chatgpt-account-id": "test-account" },
					baseUrl: currentModel.baseUrl,
				};
			},
		},
		sessionManager: {
			getBranch: () => branch,
			getEntries: () => branch,
			getSessionId: () => "session-1",
		},
		getContextUsage: () => undefined,
		getSystemPrompt: () => "test instructions",
	} as never;
}

function setup(config = autoConfig(), overrides: Record<string, unknown> = {}) {
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
	extension(pi, { loadConfig: () => config, ...overrides } as never);
	return { handlers, registered, sent, active: () => active };
}

function contextTools(payload: Record<string, unknown>) {
	return payload.tools as Array<Record<string, unknown>>;
}

test("allowlisted native Codex uses hosted windows and the reserved remote namespace schema", async () => {
	const runtime = setup();
	let authCalls = 0;
	const ctx = makeContext([], nativeCodexModel, () => { authCalls += 1; });

	await runtime.handlers.get("session_start")?.({} as never, ctx);
	expect(authCalls).toBeGreaterThan(0);
	expect(runtime.handlers.has("before_provider_headers")).toBe(true);
	expect(runtime.active()).toEqual(["read", "new_context", "get_context_remaining", "history", "notes"]);
	expect(runtime.sent.some((message) => message.customType === "codex-context-window")).toBe(true);

	const rewritten = await runtime.handlers.get("before_provider_request")?.({
		payload: {
			model: nativeCodexModel.id,
			input: [{ type: "reasoning", encrypted_content: "native-model-state" }],
			tools: [{ type: "function", name: "history" }],
		},
	} as never, ctx) as Record<string, unknown>;
	expect(rewritten.client_metadata).toBeDefined();
	expect(rewritten.input).toEqual([{ type: "reasoning", encrypted_content: "native-model-state" }]);
	const history = contextTools(rewritten)[0]!;
	expect(history.type).toBe("namespace");
	expect(history.name).toBe("history");
	const schema = JSON.stringify(history);
	// Match the previously working hosted schema: encrypted fields, open objects,
	// and no numeric bounds in the reserved namespace contract.
	expect(schema).toContain('"encrypted":true');
	expect(schema).not.toContain('"additionalProperties"');
	expect(schema).not.toContain('"minimum"');
});

test("other providers use local transport without hosted authentication", async () => {
	const runtime = setup();
	let authCalls = 0;
	const ctx = makeContext([], otherProviderModel, () => { authCalls += 1; });

	await runtime.handlers.get("session_start")?.({} as never, ctx);
	expect(authCalls).toBe(0);
	expect(runtime.active()).toEqual(["read", "new_context", "get_context_remaining", "history", "notes"]);

	const rewritten = await runtime.handlers.get("before_provider_request")?.({
		payload: {
			model: otherProviderModel.id,
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
	const schema = JSON.stringify(contextTools(rewritten)[0]);
	expect(schema).not.toContain('"encrypted":true');
	expect(schema).toContain('"additionalProperties":false');
	expect(schema).toContain('"minimum":1');
});

test("off mode and its runtime toggle deactivate context tools and windows", async () => {
	const config = autoConfig();
	config.config.compaction.contextManagement = "off";
	const runtime = setup(config);
	await runtime.handlers.get("session_start")?.({} as never, makeContext([], otherProviderModel));
	expect(runtime.active()).toEqual(["read"]);
	expect(runtime.sent).toEqual([]);

	config.config.compaction.contextManagement = "auto";
	const ctx = makeContext([], otherProviderModel);
	await runtime.handlers.get("session_start")?.({} as never, ctx);
	expect(runtime.active()).toEqual(["read", "new_context", "get_context_remaining", "history", "notes"]);
	config.config.compaction.contextManagement = "off";
	await runtime.handlers.get("model_select")?.({ model: otherProviderModel, source: "set" } as never, ctx);
	expect(runtime.active()).toEqual(["read"]);
});

test("off and disabled native Context Management leave hosted auth and tools inactive", async () => {
	const compactEvent = {
		signal: new AbortController().signal,
		reason: "threshold",
		branchEntries: [],
		preparation: { firstKeptEntryId: "keep", tokensBefore: 10, messagesToSummarize: [], turnPrefixMessages: [] },
	};
	for (const disabledBy of ["off", "enabled"] as const) {
		const config = autoConfig();
		if (disabledBy === "off") config.config.compaction.contextManagement = "off";
		else config.config.compaction.enabled = false;
		let remoteCalls = 0;
		const runtime = setup(config, {
			remoteCompact: async () => {
				remoteCalls += 1;
				return { ok: false, reason: "http-error" };
			},
			nativeFallback: async () => ({ ok: false, reason: "disabled" }),
		});
		let authCalls = 0;
		const ctx = makeContext([], nativeCodexModel, () => { authCalls += 1; });

		await runtime.handlers.get("session_start")?.({} as never, ctx);
		expect(authCalls).toBe(0);
		expect(runtime.active()).toEqual(["read"]);
		expect(runtime.sent).toEqual([]);
		// Context Management does not own disabled sessions. Off mode proceeds to
		// the normal remote-v2 compaction chain; a disabled extension does neither.
		await runtime.handlers.get("session_before_compact")?.(compactEvent as never, ctx);
		expect(remoteCalls).toBe(disabledBy === "off" ? 1 : 0);
	}

	const noModelRuntime = setup();
	let noModelAuthCalls = 0;
	await noModelRuntime.handlers.get("session_start")?.(
		{} as never,
		makeContext([], null as never, () => { noModelAuthCalls += 1; }),
	);
	expect(noModelAuthCalls).toBe(0);
	expect(noModelRuntime.active()).toEqual(["read"]);
});

test("auto routes only allowlisted native Codex models to hosted windows", async () => {
	const config = autoConfig();
	let remoteCalls = 0;
	const runtime = setup(config, {
		remoteCompact: async () => {
			remoteCalls += 1;
			return { ok: false, reason: "http-error" };
		},
		nativeFallback: async () => ({ ok: false, reason: "disabled" }),
	});
	const compactEvent = {
		signal: new AbortController().signal,
		reason: "threshold",
		branchEntries: [],
		preparation: { firstKeptEntryId: "keep", tokensBefore: 10, messagesToSummarize: [], turnPrefixMessages: [] },
	};

	for (const model of [nativeCodexModel, { ...nativeCodexModel, id: "gpt-6-astra" }, otherProviderModel]) {
		await runtime.handlers.get("session_start")?.({} as never, makeContext([], model));
		expect(runtime.active()).toEqual(["read", "new_context", "get_context_remaining", "history", "notes"]);
		expect(await runtime.handlers.get("session_before_compact")?.(compactEvent as never, makeContext([], model))).toEqual({ cancel: true });
	}

	const windowsBeforeUnlistedNative = runtime.sent.length;
	await runtime.handlers.get("session_start")?.({} as never, makeContext([], unlistedNativeCodexModel));
	expect(runtime.active()).toEqual(["read"]);
	expect(runtime.sent).toHaveLength(windowsBeforeUnlistedNative);
	await runtime.handlers.get("session_before_compact")?.(compactEvent as never, makeContext([], unlistedNativeCodexModel));
	expect(remoteCalls).toBe(1);
});
