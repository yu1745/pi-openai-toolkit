export const HISTORY_ACTIONS = [
	"list_windows",
	"list_items",
	"read_item",
	"search_contents",
] as const;

export const NOTES_ACTIONS = [
	"list_files_by_prefix",
	"read_file",
	"search_contents",
	"append_to_file",
	"write_file",
] as const;

export type HistoryAction = (typeof HISTORY_ACTIONS)[number];
export type NotesAction = (typeof NOTES_ACTIONS)[number];

export const HISTORY_DESCRIPTION =
	"Recover prior-window detail within this task. Pass window/item IDs unchanged. Defaults to the current agent; agent_name may be absolute (/root/child) or relative to the current agent. Search before browsing.";

export const NOTES_DESCRIPTION =
	"Cross-window checkpoints within this task, not project-wide memory. Paths are virtual: relative paths use the current agent's <agent_name>/notes directory; absolute paths use /root[/<agent>]/notes[/<path>] and may read or write another agent's notes in this task. Omitted prefixes use the current notes directory. Empty, dot and dot-dot path components are unsupported; ~ is literal.";
