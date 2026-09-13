import { expect, test } from "bun:test";
import { CONTEXT_AGENT_IDENTITY_ENTRY, identityFromEntries, resolveAgentName } from "./local-identity";
import { resolveLocalNotePath } from "./local-paths";

function entry(data: unknown): any {
	return { type: "custom", id: "metadata", parentId: null, timestamp: "2026-01-01T00:00:00Z", customType: CONTEXT_AGENT_IDENTITY_ENTRY, data };
}
const child = { version: 1, sessionId: "child-session", rootSessionId: "root-session", agentName: "/root/worker" };

test("root identity is session-scoped without guessing project, display name or parentSession", () => {
	expect(identityFromEntries("one", [])).toEqual({ version: 1, sessionId: "one", rootSessionId: "one", agentName: "/root" });
	expect(identityFromEntries("two", []).rootSessionId).toBe("two");
});

test("explicit identity survives resume, while copied fork metadata cannot join an old task", () => {
	expect(identityFromEntries("child-session", [entry(child)])).toEqual(child);
	expect(identityFromEntries("fork-session", [entry(child)])).toEqual({ version: 1, sessionId: "fork-session", rootSessionId: "fork-session", agentName: "/root" });
});

test("bad matching metadata fails closed instead of aliasing a valid session or agent", () => {
	for (const bad of [
		{ ...child, version: 2 }, { ...child, rootSessionId: "" }, { ...child, rootSessionId: "x\0y" },
		{ ...child, agentName: "/root/../other" }, { ...child, agentName: "/root/notes" },
		{ ...child, agentName: "/other" }, { ...child, agentName: "/root/worker/" },
	]) expect(() => identityFromEntries("child-session", [entry(bad)])).toThrow("identity");
});

test("relative agent names resolve under the caller and never escape /root", () => {
	expect(resolveAgentName(undefined, "/root/worker")).toBe("/root/worker");
	expect(resolveAgentName(null, "/root/worker")).toBe("/root/worker");
	expect(resolveAgentName("nested", "/root/worker")).toBe("/root/worker/nested");
	expect(resolveAgentName("/root/sibling", "/root/worker")).toBe("/root/sibling");
	for (const bad of ["", "..", "../sibling", "/rooted", "a//b", "a\\b", "/root/notes", "a\nb"]) {
		expect(() => resolveAgentName(bad, "/root")).toThrow();
	}
});

test("virtual note paths have remote-style current-agent defaults and explicit cross-agent paths", () => {
	expect(resolveLocalNotePath("state.md", "/root/worker").virtual).toBe("/root/worker/notes/state.md");
	expect(resolveLocalNotePath(undefined, "/root/worker", true).virtual).toBe("/root/worker/notes");
	expect(resolveLocalNotePath("/root/notes", "/root/worker", true).virtual).toBe("/root/notes");
	expect(resolveLocalNotePath("/root/other/notes/state.md", "/root/worker").relative).toBe("root/other/notes/state.md");
	// A relative child-looking file path is still inside the current notes directory.
	expect(resolveLocalNotePath("other/notes/state.md", "/root").virtual).toBe("/root/notes/other/notes/state.md");
});
