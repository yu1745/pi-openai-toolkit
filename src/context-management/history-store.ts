import { promises as fs } from "node:fs";
import * as path from "node:path";
import type { ProjectedHistoryEntry } from "./history-projector";
import type { SessionSnapshot } from "./history-source";

export const HISTORY_SCHEMA_VERSION = 3;

type Statement = {
	run(...params: unknown[]): unknown;
	all(...params: unknown[]): unknown[];
	get(...params: unknown[]): unknown;
};
type Database = {
	exec(sql: string): void;
	prepare(sql: string): Statement;
	close(): void;
};

async function openDatabase(file: string): Promise<Database> {
	await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
	if (process.versions.bun) {
		const moduleName = "bun:sqlite";
		const sqlite = await import(moduleName) as unknown as { Database: new (path: string) => Database };
		return new sqlite.Database(file);
	}
	const moduleName = "node:sqlite";
	const sqlite = await import(moduleName) as unknown as { DatabaseSync: new (path: string) => Database };
	return new sqlite.DatabaseSync(file);
}

function schema(database: Database): void {
	// Wait for another Pi process instead of treating a transient writer lock as corruption.
	database.exec("PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;");
	database.exec("BEGIN IMMEDIATE");
	try {
		const version = Number((database.prepare("PRAGMA user_version").get() as { user_version?: number } | undefined)?.user_version ?? 0);
		if (version !== 0 && version !== HISTORY_SCHEMA_VERSION) {
			// Rebuild only an explicit schema-version mismatch, in place under the SQLite lock.
			// Never unlink the database/WAL while another process may still have them open.
			database.exec("DROP TABLE IF EXISTS entries_fts; DROP TABLE IF EXISTS entries; DROP TABLE IF EXISTS source_files;");
		}
		database.exec(`
		CREATE TABLE IF NOT EXISTS source_files (
			file_path TEXT PRIMARY KEY,
			source_root TEXT NOT NULL,
			session_id TEXT NOT NULL,
			size INTEGER NOT NULL,
			mtime_ms REAL NOT NULL,
			entry_count INTEGER NOT NULL
		);
		CREATE TABLE IF NOT EXISTS entries (
			entry_key TEXT PRIMARY KEY,
			file_path TEXT NOT NULL,
			entry_id TEXT NOT NULL,
			session_id TEXT NOT NULL,
			window_id TEXT NOT NULL,
			agent_name TEXT NOT NULL,
			timestamp TEXT NOT NULL,
			sequence INTEGER NOT NULL,
			role TEXT,
			tool_name TEXT,
			tool_namespace TEXT,
			text TEXT NOT NULL
		);
		CREATE INDEX IF NOT EXISTS entries_window ON entries(window_id, timestamp);
		CREATE INDEX IF NOT EXISTS entries_item ON entries(entry_id, window_id);
		CREATE VIRTUAL TABLE IF NOT EXISTS entries_fts USING fts5(entry_key UNINDEXED, text);
		`);
		database.exec(`PRAGMA user_version=${HISTORY_SCHEMA_VERSION}`);
		database.exec("COMMIT");
	} catch (error) {
		database.exec("ROLLBACK");
		throw error;
	}
}

export async function openHistoryDatabase(file: string): Promise<Database> {
	const database = await openDatabase(file);
	try {
		schema(database);
		return database;
	} catch (error) {
		database.close();
		// Lock, permission, I/O and corruption errors are not a license to delete data.
		throw error;
	}
}

export function removeHistorySource(database: Database, filePath: string): void {
	const keys = database.prepare("SELECT entry_key FROM entries WHERE file_path = ?").all(filePath) as Array<{ entry_key: string }>;
	const removeFts = database.prepare("DELETE FROM entries_fts WHERE entry_key = ?");
	for (const row of keys) removeFts.run(row.entry_key);
	database.prepare("DELETE FROM entries WHERE file_path = ?").run(filePath);
	database.prepare("DELETE FROM source_files WHERE file_path = ?").run(filePath);
}

function insertEntry(database: Database, entry: ProjectedHistoryEntry): void {
	database.prepare(`INSERT OR REPLACE INTO entries
		(entry_key,file_path,entry_id,session_id,window_id,agent_name,timestamp,sequence,role,tool_name,tool_namespace,text)
		VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
		entry.key, entry.filePath, entry.entryId, entry.sessionId, entry.windowId,
		entry.agentName, entry.timestamp, entry.sequence, entry.role ?? null,
		entry.toolName ?? null, entry.toolNamespace ?? null, entry.text,
	);
	database.prepare("DELETE FROM entries_fts WHERE entry_key = ?").run(entry.key);
	database.prepare("INSERT INTO entries_fts(entry_key,text) VALUES (?,?)").run(entry.key, entry.text);
}

export function synchronizeSnapshot(
	database: Database,
	snapshot: SessionSnapshot,
	entries: readonly ProjectedHistoryEntry[],
): "unchanged" | "incremental" | "rebuilt" {
	const previous = database.prepare("SELECT size,mtime_ms,entry_count,session_id FROM source_files WHERE file_path = ?")
		.get(snapshot.filePath) as { size: number; mtime_ms: number; entry_count: number; session_id: string } | undefined;
	if (!snapshot.fromMemory && previous && previous.size === snapshot.size && previous.mtime_ms === snapshot.mtimeMs) {
		return "unchanged";
	}
	let start = 0;
	let outcome: "incremental" | "rebuilt" = "rebuilt";
	if (
		!snapshot.fromMemory
		&& previous
		&& previous.session_id === snapshot.sessionId
		&& snapshot.size >= previous.size
		&& entries.length >= previous.entry_count
	) {
		start = previous.entry_count;
		outcome = "incremental";
	}
	database.exec("BEGIN IMMEDIATE");
	try {
		if (outcome === "rebuilt") removeHistorySource(database, snapshot.filePath);
		for (const entry of entries.slice(start)) insertEntry(database, entry);
		database.prepare(`INSERT OR REPLACE INTO source_files(file_path,source_root,session_id,size,mtime_ms,entry_count)
			VALUES (?,?,?,?,?,?)`).run(
			snapshot.filePath, snapshot.sourceRoot, snapshot.sessionId,
			snapshot.size, snapshot.mtimeMs, entries.length,
		);
		database.exec("COMMIT");
	} catch (error) {
		database.exec("ROLLBACK");
		throw error;
	}
	return outcome;
}

export function removeDeletedSources(
	database: Database,
	retained: ReadonlySet<string>,
	sourceRoot?: string,
): void {
	const files = (sourceRoot === undefined
		? database.prepare("SELECT file_path FROM source_files").all()
		: database.prepare("SELECT file_path FROM source_files WHERE source_root = ?").all(sourceRoot)
	) as Array<{ file_path: string }>;
	for (const file of files) if (!retained.has(file.file_path)) removeHistorySource(database, file.file_path);
}

export type { Database as HistoryDatabase };
