import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { localHistoryDatabasePath } from "./local-paths";
import { localContextIdentity, resolveAgentName } from "./local-identity";
import { projectHistoryEntries } from "./history-projector";
import { loadSessionSnapshots } from "./history-source";
import {
	openHistoryDatabase,
	removeHistorySource,
	synchronizeSnapshot,
	type HistoryDatabase,
} from "./history-store";
import type { HistoryAction } from "./types";

const MAX_RESULTS = 1_000;
const MAX_ITEM_CHARS = 200_000;

type Row = {
	entry_key: string;
	entry_id: string;
	session_id: string;
	window_id: string;
	agent_name: string;
	timestamp: string;
	sequence: number;
	role: string | null;
	tool_name: string | null;
	tool_namespace: string | null;
	text: string;
};

function bounded(value: unknown, fallback: number, maximum: number): number {
	return typeof value === "number" && Number.isInteger(value) && value > 0
		? Math.min(value, maximum)
		: fallback;
}

async function synchronizedDatabase(ctx: ExtensionContext): Promise<HistoryDatabase> {
	const database = await openHistoryDatabase(localHistoryDatabasePath(ctx));
	try {
		const { snapshots, missingFiles } = await loadSessionSnapshots(ctx);
		for (const snapshot of snapshots) {
			synchronizeSnapshot(
				database,
				snapshot,
				projectHistoryEntries(snapshot.entries, snapshot.sessionId, snapshot.filePath, snapshot.agentName),
			);
		}
		for (const file of missingFiles) removeHistorySource(database, file);
		return database;
	} catch (error) {
		database.close();
		throw error;
	}
}

/** Snapshot live SDK sessions before their extension instance shuts down. */
export async function checkpointLocalHistory(ctx: ExtensionContext): Promise<void> {
	const database = await synchronizedDatabase(ctx);
	database.close();
}

function filters(params: Record<string, unknown>, agentName: string, alias = "e") {
	const clauses: string[] = [`${alias}.agent_name = ?`];
	const values: unknown[] = [agentName];
	for (const [field, column] of [
		["window_id", "window_id"],
		["role", "role"],
		["tool_name", "tool_name"],
		["tool_namespace", "tool_namespace"],
	] as const) {
		if (params[field] !== undefined && params[field] !== null) {
			clauses.push(`${alias}.${column} = ?`);
			values.push(params[field]);
		}
	}
	return { sql: clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "", values };
}

function publicItem(row: Row, maximum = 4_000) {
	return {
		id: row.entry_id,
		session_id: row.session_id,
		window_id: row.window_id,
		agent_name: row.agent_name,
		role: row.role ?? undefined,
		timestamp: row.timestamp,
		tool_name: row.tool_name ?? undefined,
		tool_namespace: row.tool_namespace ?? undefined,
		text: row.text.slice(0, maximum),
	};
}

export async function executeLocalHistory(
	action: HistoryAction,
	params: Record<string, unknown>,
	ctx: ExtensionContext,
): Promise<Record<string, unknown>> {
	const agentName = resolveAgentName(params.agent_name, localContextIdentity(ctx).agentName);
	const database = await synchronizedDatabase(ctx);
	try {
		if (action === "list_windows") {
			const where = filters(params, agentName);
			const direction = params.recent_first === false ? "ASC" : "DESC";
			const rows = database.prepare(`SELECT window_id AS id, session_id, agent_name,
				MIN(timestamp) AS created_at, COUNT(*) AS item_count
				FROM entries e${where.sql} GROUP BY window_id,session_id,agent_name
				ORDER BY created_at ${direction} LIMIT ?`)
				.all(...where.values, bounded(params.limit, 100, MAX_RESULTS));
			return { windows: rows };
		}
		if (action === "read_item") {
			const rows = database.prepare("SELECT * FROM entries WHERE entry_id = ? AND window_id = ? AND agent_name = ? ORDER BY timestamp")
				.all(params.item_id, params.window_id, agentName) as Row[];
			if (rows.length === 0) throw new Error("history item not found in the requested window");
			if (rows.length !== 1) {
				throw new Error("history item id is ambiguous in the requested window; select a unique window/item pair");
			}
			const row = rows[0]!;
			const offset = typeof params.offset_chars === "number" ? params.offset_chars : 0;
			const limit = bounded(params.limit_chars, 50_000, MAX_ITEM_CHARS);
			return {
				item: {
					...publicItem(row, MAX_ITEM_CHARS),
					text: row.text.slice(offset, offset + limit),
					offset_chars: offset,
					total_chars: row.text.length,
				},
			};
		}

		const where = filters(params, agentName);
		const direction = params.recent_first === false ? "ASC" : "DESC";
		const limit = bounded(params.limit, 100, MAX_RESULTS);
		if (action === "list_items") {
			const rows = database.prepare(`SELECT * FROM entries e${where.sql}
				ORDER BY timestamp ${direction}, sequence ${direction} LIMIT ?`)
				.all(...where.values, limit) as Row[];
			const maximum = bounded(params.max_chars_per_item, 4_000, 50_000);
			return { items: rows.map((row) => publicItem(row, maximum)) };
		}

		// FTS token/phrase matching is not literal substring matching (e.g. "pha" in "alpha").
		// Apply the exact, case-sensitive predicate before LIMIT; never silently lose candidates.
		const rows = database.prepare(`SELECT e.* FROM entries e${where.sql} AND instr(e.text, ?) > 0
			ORDER BY e.timestamp ${direction}, e.sequence ${direction} LIMIT ?`)
			.all(...where.values, String(params.query), limit) as Row[];
		return { matches: rows.map((row) => publicItem(row)) };
	} finally {
		database.close();
	}
}
