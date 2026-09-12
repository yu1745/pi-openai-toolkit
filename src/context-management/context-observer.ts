import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CONFIG_DIR } from "../config";
import { projectIdentity, type ProjectIdentity } from "./local-paths";
import type { ContextRemaining } from "./window-budget";
import type { ContextWindowIdentity } from "./types";

export const CONTEXT_STATUS_PROTOCOL = 1 as const;
export const MAX_CONTEXT_STATUS_BYTES = 16 * 1024;

export type ContextBackend = "remote" | "local" | "off";
export type ContextLifecycleEvent =
	| "runtime"
	| "window-initialized"
	| "window-restored"
	| "reminder"
	| "fallback"
	| "notes-checkpoint"
	| "rollover-requested"
	| "rollover-completed"
	| "rollover-refused";

export interface ContextStatusDetails {
	backend: ContextBackend;
	active: boolean;
	projectIdentity: ProjectIdentity;
	window: {
		id?: string;
		number?: number;
		initialized: boolean;
		restored: boolean;
	};
	budget: {
		remainingTokens?: number;
		contextWindow: number;
		thresholdPercent: number;
		thresholdTokens: number;
		reminderTriggered: boolean;
		fallbackTriggered: boolean;
	};
	notesCheckpoint: {
		success: boolean;
		sizeBytes?: number;
		at?: string;
	};
	rollover: {
		requested: boolean;
		completed: boolean;
		refused: boolean;
		requestedAt?: string;
		completedAt?: string;
		refusedAt?: string;
		refusalReason?: "notes-checkpoint-required" | "already-scheduled" | "aborted" | "failed";
	};
	restoration: {
		status: "none" | "restored" | "initialized" | "rollover-completed";
		at?: string;
	};
}

type PersistedContextStatus = ContextStatusDetails & {
	protocol: typeof CONTEXT_STATUS_PROTOCOL;
	updatedAt: string;
	/** Hash of project key plus the Pi session id; the raw id is not persisted. */
	sessionKey: string;
};

type LifecycleWriter = (
	event: ContextLifecycleEvent,
	status: PersistedContextStatus,
	ctx: ExtensionContext,
) => void;

function now(): string {
	return new Date().toISOString();
}

function sessionKey(ctx: Pick<ExtensionContext, "sessionManager">, identity: ProjectIdentity): string {
	return createHash("sha256")
		.update(identity.key)
		.update("\0")
		.update(ctx.sessionManager.getSessionId())
		.digest("hex");
}

export function localContextStatusPath(ctx: Pick<ExtensionContext, "sessionManager">): string {
	const identity = projectIdentity(ctx);
	return path.join(
		CONFIG_DIR,
		"context-management",
		"status",
		identity.key,
		sessionKey(ctx, identity),
		"latest.json",
	);
}

function ensureSecureDirectory(directory: string): void {
	fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
	const stat = fs.lstatSync(directory);
	if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("status directory is not safe");
	fs.chmodSync(directory, 0o700);
}

function writeAtomicStatus(file: string, status: PersistedContextStatus): void {
	const payload = `${JSON.stringify(status, null, 2)}\n`;
	if (Buffer.byteLength(payload) > MAX_CONTEXT_STATUS_BYTES) {
		throw new Error("context status exceeds its fixed size limit");
	}
	const directory = path.dirname(file);
	ensureSecureDirectory(directory);
	const temporary = path.join(directory, `.latest.${process.pid}.${randomUUID()}.tmp`);
	let descriptor: number | undefined;
	try {
		descriptor = fs.openSync(
			temporary,
			fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
			0o600,
		);
		fs.writeFileSync(descriptor, payload, "utf8");
		fs.fsyncSync(descriptor);
		fs.closeSync(descriptor);
		descriptor = undefined;
		fs.renameSync(temporary, file);
		fs.chmodSync(file, 0o600);
	} catch (error) {
		if (descriptor !== undefined) {
			try { fs.closeSync(descriptor); } catch { /* best effort */ }
		}
		try { fs.rmSync(temporary, { force: true }); } catch { /* best effort */ }
		throw error;
	}
}

function initialDetails(identity: ProjectIdentity): ContextStatusDetails {
	return {
		backend: "off",
		active: false,
		projectIdentity: identity,
		window: { initialized: false, restored: false },
		budget: {
			contextWindow: 0,
			thresholdPercent: 5,
			thresholdTokens: 0,
			reminderTriggered: false,
			fallbackTriggered: false,
		},
		notesCheckpoint: { success: false },
		rollover: { requested: false, completed: false, refused: false },
		restoration: { status: "none" },
	};
}

export class ContextStatusObserver {
	private key: string | undefined;
	private details: ContextStatusDetails | undefined;
	private runtimeObserved = false;

	constructor(private readonly lifecycleWriter?: LifecycleWriter) {}

	reset(): void {
		this.key = undefined;
		this.details = undefined;
		this.runtimeObserved = false;
	}

	observeRuntime(
		ctx: ExtensionContext,
		backend: ContextBackend,
		active: boolean,
		thresholdPercent: number,
	): void {
		const details = this.ensureSession(ctx);
		if (!details) return;
		const changed = !this.runtimeObserved
			|| details.backend !== backend
			|| details.active !== active
			|| details.budget.thresholdPercent !== thresholdPercent;
		details.backend = backend;
		details.active = active;
		details.budget.thresholdPercent = thresholdPercent;
		details.budget.thresholdTokens = Math.floor((details.budget.contextWindow * thresholdPercent) / 100);
		this.runtimeObserved = true;
		if (changed) this.publish(ctx, "runtime");
	}

	recordRestoration(
		ctx: ExtensionContext,
		identity: ContextWindowIdentity | undefined,
		options: { reminderTriggered: boolean; fallbackTriggered: boolean; notesCheckpointSuccess: boolean; notesSizeBytes?: number },
	): void {
		const details = this.ensureSession(ctx);
		if (!details) return;
		if (!identity) {
			details.window = { initialized: false, restored: false };
			details.restoration = { status: "none", at: now() };
			this.publish(ctx);
			return;
		}
		const unchanged = details.window.id === identity.currentWindowId
			&& details.window.restored
			&& details.budget.reminderTriggered === options.reminderTriggered
			&& details.budget.fallbackTriggered === options.fallbackTriggered
			&& details.notesCheckpoint.success === options.notesCheckpointSuccess
			&& details.notesCheckpoint.sizeBytes === options.notesSizeBytes;
		this.setWindow(details, identity);
		details.window.restored = true;
		details.budget.reminderTriggered = options.reminderTriggered;
		details.budget.fallbackTriggered = options.fallbackTriggered;
		details.notesCheckpoint = {
			success: options.notesCheckpointSuccess,
			...(options.notesSizeBytes !== undefined ? { sizeBytes: options.notesSizeBytes } : {}),
		};
		if (!unchanged) {
			details.restoration = { status: "restored", at: now() };
			this.publish(ctx, "window-restored");
		}
	}

	recordWindowInitialized(ctx: ExtensionContext, identity: ContextWindowIdentity): void {
		const details = this.ensureSession(ctx);
		if (!details) return;
		this.setWindow(details, identity);
		details.window.initialized = true;
		details.restoration = { status: "initialized", at: now() };
		this.publish(ctx, "window-initialized");
	}

	recordBudget(
		ctx: ExtensionContext,
		remaining: ContextRemaining,
		thresholdPercent: number,
		triggered?: "reminder" | "fallback",
	): void {
		const details = this.ensureSession(ctx);
		if (!details) return;
		const prior = details.budget;
		details.budget = {
			...prior,
			...(remaining.remainingTokens !== undefined ? { remainingTokens: remaining.remainingTokens } : {}),
			contextWindow: remaining.contextWindow,
			thresholdPercent,
			thresholdTokens: Math.floor((remaining.contextWindow * thresholdPercent) / 100),
			reminderTriggered: details.budget.reminderTriggered || triggered === "reminder",
			fallbackTriggered: details.budget.fallbackTriggered || triggered === "fallback",
		};
		if (remaining.remainingTokens === undefined) delete details.budget.remainingTokens;
		// Ordinary per-turn budget movement is memory-only. A lifecycle transition
		// persists the latest in-memory budget, and an explicit status query can
		// request a snapshot below.
		if (triggered) this.publish(ctx, triggered);
	}

	recordNotesCheckpoint(ctx: ExtensionContext, sizeBytes?: number): void {
		const details = this.ensureSession(ctx);
		if (!details) return;
		details.notesCheckpoint = {
			success: true,
			...(sizeBytes !== undefined ? { sizeBytes } : {}),
			at: now(),
		};
		this.publish(ctx, "notes-checkpoint");
	}

	recordRolloverRequested(ctx: ExtensionContext): void {
		const details = this.ensureSession(ctx);
		if (!details) return;
		details.rollover = {
			requested: true,
			completed: false,
			refused: false,
			requestedAt: now(),
		};
		this.publish(ctx, "rollover-requested");
	}

	recordRolloverCompleted(ctx: ExtensionContext, identity: ContextWindowIdentity): void {
		const details = this.ensureSession(ctx);
		if (!details) return;
		this.setWindow(details, identity);
		details.rollover.completed = true;
		details.rollover.completedAt = now();
		details.restoration = { status: "rollover-completed", at: details.rollover.completedAt };
		this.publish(ctx, "rollover-completed");
	}

	recordRolloverRefused(
		ctx: ExtensionContext,
		reason: NonNullable<ContextStatusDetails["rollover"]["refusalReason"]>,
	): void {
		const details = this.ensureSession(ctx);
		if (!details) return;
		details.rollover.refused = true;
		details.rollover.refusedAt = now();
		details.rollover.refusalReason = reason;
		this.publish(ctx, "rollover-refused");
	}

	snapshot(ctx: ExtensionContext, persist = false): ContextStatusDetails {
		const details = this.ensureSession(ctx);
		if (!details) {
			return initialDetails({
				kind: "canonical-cwd",
				key: createHash("sha256").update("unavailable-project-identity").digest("hex"),
			});
		}
		if (persist) this.publish(ctx);
		return structuredClone(details);
	}

	private ensureSession(ctx: ExtensionContext): ContextStatusDetails | undefined {
		try {
			const identity = projectIdentity(ctx);
			const nextKey = sessionKey(ctx, identity);
			if (!this.details || this.key !== nextKey) {
				this.key = nextKey;
				this.details = initialDetails(identity);
				this.runtimeObserved = false;
			} else {
				this.details.projectIdentity = identity;
			}
			return this.details;
		} catch {
			return undefined;
		}
	}

	private setWindow(details: ContextStatusDetails, identity: ContextWindowIdentity): void {
		if (details.window.id !== identity.currentWindowId) {
			details.window = {
				id: identity.currentWindowId,
				number: identity.windowNumber,
				initialized: false,
				restored: false,
			};
			delete details.budget.remainingTokens;
			details.budget.reminderTriggered = false;
			details.budget.fallbackTriggered = false;
			details.notesCheckpoint = { success: false };
		} else {
			details.window.number = identity.windowNumber;
		}
	}

	private publish(ctx: ExtensionContext, event?: ContextLifecycleEvent): void {
		try {
			const details = this.ensureSession(ctx);
			if (!details || !this.key) return;
			const persisted: PersistedContextStatus = {
				protocol: CONTEXT_STATUS_PROTOCOL,
				updatedAt: now(),
				sessionKey: this.key!,
				...structuredClone(details),
			};
			writeAtomicStatus(localContextStatusPath(ctx), persisted);
			if (event) {
				try { this.lifecycleWriter?.(event, persisted, ctx); } catch { /* observer only */ }
			}
		} catch {
			// Observability must never affect the request, tool result, or rollover.
		}
	}
}

export const _contextObserverTest = { writeAtomicStatus };
