import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { isRecord } from "./types";

const MAX_INDEXED_TEXT_CHARS = 200_000;
const REDACTED = "[opaque content omitted]";

export type RenderedEntry = {
	text: string;
	role?: string;
	toolName?: string;
	toolNamespace?: string;
};

function renderBlock(value: unknown): string {
	if (!isRecord(value)) return "";
	if (value.type === "text" && typeof value.text === "string") return value.text;
	if (value.type === "toolCall") {
		const name = typeof value.name === "string" ? value.name : "tool";
		return `[tool call: ${name}]`;
	}
	if (value.type === "image" || value.type === "image_url" || value.type === "input_image") {
		return "[image omitted]";
	}
	if (value.type === "thinking" || value.type === "reasoning" || value.type === "encrypted_content") {
		return REDACTED;
	}
	return "";
}

function renderContent(value: unknown): string {
	if (typeof value === "string") return value;
	if (!Array.isArray(value)) return "";
	return value.map(renderBlock).filter(Boolean).join("\n");
}

function bounded(text: string): string {
	return text.length <= MAX_INDEXED_TEXT_CHARS ? text : text.slice(0, MAX_INDEXED_TEXT_CHARS);
}

export function renderHistoryEntry(entry: SessionEntry): RenderedEntry {
	if (entry.type === "message") {
		const message = entry.message as unknown as Record<string, unknown>;
		const role = message.role === "toolResult"
			? "tool"
			: typeof message.role === "string" ? message.role : undefined;
		return {
			text: bounded(renderContent(message.content)),
			role,
			toolName: typeof message.toolName === "string" ? message.toolName : undefined,
			toolNamespace: typeof message.toolNamespace === "string" ? message.toolNamespace : undefined,
		};
	}
	if (entry.type === "custom_message") {
		return { text: bounded(renderContent(entry.content)), role: "system" };
	}
	if (entry.type === "compaction" || entry.type === "branch_summary") {
		return { text: bounded(entry.summary), role: "system" };
	}
	// Metadata entries are deliberately not serialized wholesale: details can
	// contain opaque checkpoints, credentials, or large extension payloads.
	return { text: `[${entry.type}]` };
}
