import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { renderHistoryEntry } from "./history-renderer";
import {
	CODEX_CONTEXT_WINDOW_MESSAGE_TYPE,
	isCodexContextManagementMessageDetails,
} from "./types";

export type ProjectedHistoryEntry = {
	key: string;
	filePath: string;
	entryId: string;
	sessionId: string;
	windowId: string;
	agentName: string;
	timestamp: string;
	sequence: number;
	text: string;
	role?: string;
	toolName?: string;
	toolNamespace?: string;
};

export function projectHistoryEntries(
	entries: readonly SessionEntry[],
	sessionId: string,
	filePath: string,
): ProjectedHistoryEntry[] {
	const byId = new Map(entries.map((entry) => [entry.id, entry]));
	const windows = new Map<string, string>();
	const resolveWindow = (entry: SessionEntry, seen = new Set<string>()): string => {
		const cached = windows.get(entry.id);
		if (cached) return cached;
		if (seen.has(entry.id)) return sessionId;
		seen.add(entry.id);
		if (
			entry.type === "custom_message"
			&& entry.customType === CODEX_CONTEXT_WINDOW_MESSAGE_TYPE
			&& isCodexContextManagementMessageDetails(entry.details)
			&& entry.details.contextManagement.kind === "window"
		) {
			const id = entry.details.contextManagement.currentWindowId;
			windows.set(entry.id, id);
			return id;
		}
		const parent = entry.parentId ? byId.get(entry.parentId) : undefined;
		const id = parent ? resolveWindow(parent, seen) : sessionId;
		windows.set(entry.id, id);
		return id;
	};
	return entries.map((entry, sequence) => ({
		key: `${filePath}\u0000${entry.id}`,
		filePath,
		entryId: entry.id,
		sessionId,
		windowId: resolveWindow(entry),
		agentName: "/root",
		timestamp: entry.timestamp,
		sequence,
		...renderHistoryEntry(entry),
	}));
}
