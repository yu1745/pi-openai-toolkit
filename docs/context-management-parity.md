# Local context: task scope and agent namespaces

With `contextManagement: "auto"`, every provider, including native `openai-codex`, uses this local history/notes and window-transport backend. It makes no Codex alpha history/notes request, OAuth resolution, hosted context-header rewrite, or encrypted tool-output rewrite. It mirrors the public **task/session and agent addressing contract** of Codex history/notes, but it does not reproduce OpenAI's encrypted model-only state. Existing remote context data is not migrated; opaque remote history/notes outputs are omitted from local request transport, while ordinary native-model reasoning remains intact.

## Identity contract

A Pi SDK host may append this custom entry **before binding extensions**:

```json
{
  "type": "custom",
  "customType": "context-management-agent-identity",
  "data": {
    "version": 1,
    "sessionId": "actual-child-pi-session-id",
    "rootSessionId": "root-task-pi-session-id",
    "agentName": "/root/stable-child-id"
  }
}
```

Use `SessionManager.appendCustomEntry(customType, data)`; Pi supplies entry IDs, timestamps and parent links. This is host metadata, not a tool argument or an instruction parsed from conversation text.

- `sessionId` must match the actual current Pi session. Copied entries from `/fork` never associate a new session with an old task.
- With no matching entry, the session is independent: `rootSessionId = current Pi session ID`, `agentName = /root`.
- A nested child inherits its parent's root identity and appends a stable child ID to the parent's agent path. Aliases and display names do not change storage identity.
- Agent names start with `/root`; segments contain ASCII letters, digits, `_`, `-`, or `.`, but cannot be empty, `.`, `..`, or `notes`. The path is bounded to 1,024 characters. `notes` is reserved as the virtual directory delimiter.
- Resuming a session preserves its identity. Do not reinterpret `parentSession` as a task-membership grant: normal forks also contain that header.
- Unknown/malformed matching identity versions fail closed rather than joining an unintended namespace.

The companion [pi-subagents patch](../patches/pi-subagents-context-identity.md) adds this metadata without coupling the packages through an import. It must be applied through the fork's chosen maintenance process; it is not automatically installed or applied by this toolkit. Without the bridge, independently created SDK child sessions remain independent `/root` sessions. Do not claim multi-agent task sharing is active merely because tools expose `agent_name`.

## Addressing

Given current agent `/root/worker`:

| Operation | Scope |
| --- | --- |
| `notes.read_file(path="state.md")` | `/root/worker/notes/state.md` |
| `notes.read_file(path="/root/notes/state.md")` | Root agent's notes, same task |
| `notes.list_files_by_prefix()` | Only `/root/worker/notes/` |
| `notes.search_contents(path_prefix="/root/other/notes", ...)` | Other agent's notes, same task |
| `history.list_items()` | Current agent |
| `history.list_items(agent_name="deep")` | `/root/worker/deep` |
| `history.read_item(agent_name="/root", ...)` | Root agent; still requires the returned window/item pair |

Absolute note paths are **virtual**, never arbitrary filesystem paths. File operations require a file component after `notes`; prefix operations may use the notes directory itself. Empty, dot, dot-dot and backslash components are rejected. `~` is literal, not shell expansion. Returned note paths are canonical absolute virtual paths, so they can be passed unchanged between agents in the task.

Namespaces prevent accidental mixing, not cross-agent authorization: intentional cross-agent reads and writes within the task are supported, as in the public remote contract.

## Storage and recovery

```
context-management/
  sessions/<sha256(rootSessionId)>/
    agents/root/notes/...
    agents/root/<child-id>/notes/...
    sources/<sha256(piSessionId)>.json
    locks/<sha256(virtual-note-path)>.lock
    history.sqlite
```

Active local sessions register their exact sources at startup/activation. A process-wide registry exposes live SDK session entries, including unpersisted turns. Small source manifests allow persistent JSONL sessions in different session directories/worktrees to be reopened without scanning the project or the user's global session tree. Both manifest and JSONL identity must agree before indexing.

The SQLite index stores `agent_name`, concrete source session ID, window ID and item ID. The database path enforces root-task scope; every query also enforces the selected agent. Confirmed source deletion removes its indexed entries; temporary unreadability does not immediately erase an existing index. A final best-effort snapshot is taken when a local extension instance shuts down. SQLite waits up to five seconds for a competing writer; only an explicit schema-version mismatch rebuilds tables, in place under a transaction. Lock, I/O and corruption errors do not unlink the database or its WAL files.

Old project-keyed notes and indexes are left untouched and are not imported. This intentionally changes the default visible notes: it does not delete the old files. Copying old notes into a new task is an explicit user operation, not a migration inferred from cwd.

## Alignment and remaining gaps

| Area | Local status |
| --- | --- |
| Task/session boundary | Implemented; `/new` and `/fork` are independent unless the host explicitly associates a child |
| Current-agent default, absolute/relative agent names | Implemented for all history operations, including `read_item` |
| Agent-rooted virtual notes and explicit cross-agent access | Implemented |
| Notes required before rolling the current window | Retained; another session's old notes do not satisfy the checkpoint gate |
| Literal history search | Case-sensitive substring predicate before result limits; not token-only FTS matching |
| Live child-session history | Requires the host identity bridge and local toolkit activation in the child |
| Persistent history after restart | Rebuilt from explicitly registered Pi JSONL sources |
| In-memory child history | Available live and via its final index snapshot; not reconstructible after index loss/rebuild |
| OpenAI encrypted arguments/results and private reasoning state | Not reproduced or decrypted locally; legacy encrypted history/notes outputs are omitted rather than sent as local content |
| History images, complete tool arguments, oversized entries | Existing text projection still omits images/opaque blocks/tool-argument bodies and bounds each entry; not lossless remote parity |
| Notes write concurrency | Atomic publication, a shared in-process queue and an exclusive local-file lock covering the full read-modify-write; lock waiting is bounded and abortable |
| Backend consistency/performance | Local reads use local files/SQLite; remote eventual-consistency and latency behavior are not emulated |
| Historical subagents created without identity metadata | Not silently assigned to a task or agent by guessing |

Remote data migration is explicitly not promised. The local-file lock assumes a local filesystem with exclusive creation and atomic rename. A crashed process can leave a `.lock` file; the next writer fails after five seconds rather than stealing a potentially live lock. An operator may remove it only after verifying the recorded PID is no longer writing. This is not a distributed storage service.

A single tool result may still aggregate many bounded items. Output budgeting, history attachments and full-text fidelity need separate parity work before claiming a drop-in remote replacement. The remote service implementation is not public; mock/contract parity is not proof of identical server semantics.

## Optional semantic recall

A future zvec-grep integration should be a separate, optional semantic retrieval path, not a change to `search_contents`' literal contract. Apply task/agent scope **before retrieval**, return source session/window/item identifiers, and verify candidates with exact history reads. JSONL/SQLite remains the authoritative retrieval surface. Do not automatically create an embedding index or send history to a remote embedding service just because context management is enabled.

## Public references

- [Codex history/notes tool contract](https://github.com/openai/codex/blob/1715e55076737158ba61d43158ede504de6d4ce1/codex-rs/ext/history-notes/src/tools.rs)
- [Codex identity and thread-hint wiring](https://github.com/openai/codex/blob/1715e55076737158ba61d43158ede504de6d4ce1/codex-rs/ext/history-notes/src/extension.rs)
- [Why Codex added new_context](https://github.com/openai/codex/commit/87ab01834af30cfae99014ca93035d3068716b3f)
