import type { ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { isRecord } from "./types";

/** Shared, dependency-free protocol with SDK hosts such as pi-subagents. */
export const CONTEXT_AGENT_IDENTITY_ENTRY = "context-management-agent-identity";

export type ContextAgentIdentity = {
	version: 1;
	/** The concrete Pi session owning this entry, not the parent/root session. */
	sessionId: string;
	/** One task, including explicitly associated child agents. Never a project id. */
	rootSessionId: string;
	agentName: string;
};

export function validAgentName(value: unknown): value is string {
	if (typeof value !== "string" || value.length > 1_024 || !value.startsWith("/root")) return false;
	const parts = value.slice(1).split("/");
	return parts[0] === "root" && parts.every((part) =>
		/^[A-Za-z0-9_.-]+$/.test(part) && part !== "." && part !== ".." && part !== "notes",
	);
}

export function resolveAgentName(value: unknown, currentAgent: string): string {
	if (value === undefined || value === null) return currentAgent;
	if (typeof value !== "string" || !value) throw new Error("agent_name must be a non-empty agent path");
	const absolute = value.startsWith("/") ? value : `${currentAgent}/${value}`;
	if (!validAgentName(absolute)) throw new Error("invalid agent_name; use /root or a descendant agent path");
	return absolute;
}

export function identityFromEntries(
	sessionId: string,
	entries: readonly SessionEntry[],
): ContextAgentIdentity {
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index]!;
		if (entry.type !== "custom" || entry.customType !== CONTEXT_AGENT_IDENTITY_ENTRY) continue;
		const data = entry.data;
		if (!isRecord(data) || data.sessionId !== sessionId) continue;
		// Invalid matching metadata must not silently fall into another scope.
		if (data.version !== 1 || typeof data.rootSessionId !== "string" || !data.rootSessionId.trim()
			|| data.rootSessionId.includes("\0") || !validAgentName(data.agentName)) {
			throw new Error("invalid context-management agent identity");
		}
		return { version: 1, sessionId, rootSessionId: data.rootSessionId, agentName: data.agentName };
	}
	// /new and /fork get new Pi ids. Copied identity entries never join their old task.
	return { version: 1, sessionId, rootSessionId: sessionId, agentName: "/root" };
}

export function localContextIdentity(ctx: Pick<ExtensionContext, "sessionManager">): ContextAgentIdentity {
	return identityFromEntries(ctx.sessionManager.getSessionId(), ctx.sessionManager.getEntries?.() ?? []);
}
