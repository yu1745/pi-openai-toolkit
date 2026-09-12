import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import * as path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CONFIG_DIR } from "../config";

export function canonicalPath(input: string): string {
	const resolved = path.resolve(input);
	try {
		return realpathSync.native(resolved);
	} catch {
		return resolved;
	}
}

export type ProjectIdentity = {
	kind: "git-common-dir" | "canonical-cwd";
	/** SHA-256 of the identity path. The path itself is never exposed. */
	key: string;
};

const GIT_PROBE_TIMEOUT_MS = 500;
const MAX_PROJECT_IDENTITY_CACHE_ENTRIES = 512;
const projectIdentityCache = new Map<string, ProjectIdentity>();

function hashIdentityPath(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function probeGitCommonDirectory(cwd: string, executable = "git"): string | undefined {
	const env: NodeJS.ProcessEnv = {
		...process.env,
		GIT_TERMINAL_PROMPT: "0",
		GCM_INTERACTIVE: "Never",
		GIT_OPTIONAL_LOCKS: "0",
	};
	// Repository-selection variables describe the caller's Git operation, not
	// the session cwd. Let rev-parse discover the repository from cwd itself.
	for (const name of ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE"] as const) {
		delete env[name];
	}
	const result = spawnSync(executable, ["rev-parse", "--git-common-dir"], {
		cwd,
		shell: false,
		windowsHide: true,
		encoding: "utf8",
		timeout: GIT_PROBE_TIMEOUT_MS,
		maxBuffer: 16 * 1024,
		stdio: ["ignore", "pipe", "ignore"],
		env,
	});
	if (result.error || result.status !== 0 || typeof result.stdout !== "string") return undefined;
	const output = result.stdout.replace(/[\r\n]+$/, "");
	if (!output || output.includes("\0") || output.includes("\n") || output.includes("\r")) return undefined;
	return canonicalPath(path.resolve(cwd, output));
}

function uncachedProjectIdentity(cwd: string, gitExecutable = "git"): ProjectIdentity {
	const canonicalCwd = canonicalPath(cwd);
	const gitCommonDirectory = probeGitCommonDirectory(canonicalCwd, gitExecutable);
	return gitCommonDirectory
		? { kind: "git-common-dir", key: hashIdentityPath(gitCommonDirectory) }
		: { kind: "canonical-cwd", key: hashIdentityPath(canonicalCwd) };
}

export function projectIdentityForCwd(cwd: string): ProjectIdentity {
	const canonicalCwd = canonicalPath(cwd);
	const cached = projectIdentityCache.get(canonicalCwd);
	if (cached) return { ...cached };
	const identity = uncachedProjectIdentity(canonicalCwd);
	if (projectIdentityCache.size >= MAX_PROJECT_IDENTITY_CACHE_ENTRIES) {
		const oldest = projectIdentityCache.keys().next().value;
		if (oldest !== undefined) projectIdentityCache.delete(oldest);
	}
	projectIdentityCache.set(canonicalCwd, identity);
	return { ...identity };
}

export function projectIdentity(ctx: Pick<ExtensionContext, "sessionManager">): ProjectIdentity {
	return projectIdentityForCwd(ctx.sessionManager.getCwd());
}

export function projectKey(ctx: Pick<ExtensionContext, "sessionManager">): string {
	return projectIdentity(ctx).key;
}

export const _localPathsTest = {
	uncachedProjectIdentity,
	clearProjectIdentityCache: () => projectIdentityCache.clear(),
};

export function localNotesRoot(ctx: ExtensionContext): string {
	return path.join(CONFIG_DIR, "context-management", "notes", projectKey(ctx));
}

export function localHistoryDatabasePath(ctx: ExtensionContext): string {
	return path.join(CONFIG_DIR, "context-management", "history", `${projectKey(ctx)}.sqlite`);
}

export function safeRelativePath(raw: unknown, label = "path"): string {
	if (typeof raw !== "string" || raw.length === 0 || raw.includes("\0") || path.isAbsolute(raw)) {
		throw new Error(`${label} must be a non-empty relative path`);
	}
	const normalized = path.posix.normalize(raw.replaceAll("\\", "/"));
	if (normalized === "." || normalized === ".." || normalized.startsWith("../")) {
		throw new Error(`${label} escapes the project tree`);
	}
	return normalized;
}

export function safeOptionalPrefix(raw: unknown): string {
	return raw === undefined || raw === null || raw === "" ? "" : safeRelativePath(raw, "prefix");
}
