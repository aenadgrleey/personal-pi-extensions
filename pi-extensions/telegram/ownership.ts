import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const AGENT_DIR = path.join(os.homedir(), ".pi", "agent");
const OWNER_FILE = path.join(AGENT_DIR, "telegram-active-session.json");
const STALE_MS = 90_000;

export interface TelegramOwnerState {
	version: 1;
	sessionId: string;
	sessionFile?: string;
	cwd: string;
	pid: number;
	busy: boolean;
	updatedAt: number;
}

export interface TelegramOwnerClaim {
	sessionId: string;
	sessionFile?: string;
	cwd: string;
	busy: boolean;
}

function isPidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function isOwnerState(value: unknown): value is TelegramOwnerState {
	if (!value || typeof value !== "object") return false;
	const state = value as Partial<TelegramOwnerState>;
	return (
		state.version === 1 &&
		typeof state.sessionId === "string" &&
		typeof state.cwd === "string" &&
		typeof state.pid === "number" &&
		typeof state.busy === "boolean" &&
		typeof state.updatedAt === "number"
	);
}

function readOwnerFile(): TelegramOwnerState | undefined {
	try {
		if (!fs.existsSync(OWNER_FILE)) return undefined;
		const parsed = JSON.parse(fs.readFileSync(OWNER_FILE, "utf8")) as unknown;
		return isOwnerState(parsed) ? parsed : undefined;
	} catch {
		return undefined;
	}
}

function writeOwnerFile(claim: TelegramOwnerClaim): TelegramOwnerState {
	const next: TelegramOwnerState = {
		version: 1,
		sessionId: claim.sessionId,
		sessionFile: claim.sessionFile,
		cwd: claim.cwd,
		pid: process.pid,
		busy: claim.busy,
		updatedAt: Date.now(),
	};
	fs.mkdirSync(path.dirname(OWNER_FILE), { recursive: true });
	fs.writeFileSync(OWNER_FILE, `${JSON.stringify(next, null, 2)}\n`, "utf8");
	return next;
}

export function isTelegramOwnerStateStale(
	state: TelegramOwnerState,
	options?: {
		now?: number;
		staleMs?: number;
		isPidAlive?: (pid: number) => boolean;
	},
): boolean {
	const now = options?.now ?? Date.now();
	const staleMs = options?.staleMs ?? STALE_MS;
	const isAlive = options?.isPidAlive ?? isPidAlive;
	return now - state.updatedAt > staleMs || !isAlive(state.pid);
}

function isStale(state: TelegramOwnerState): boolean {
	return isTelegramOwnerStateStale(state);
}

export function getTelegramOwnerFile(): string {
	return OWNER_FILE;
}

export function readTelegramOwnerState(): TelegramOwnerState | undefined {
	const state = readOwnerFile();
	if (!state) return undefined;
	if (isStale(state)) return undefined;
	return state;
}

export function evaluateTelegramOwnershipClaim(
	previous: TelegramOwnerState | undefined,
	claim: TelegramOwnerClaim,
	options?: {
		currentPid?: number;
		now?: number;
		staleMs?: number;
		isPidAlive?: (pid: number) => boolean;
	},
): {
	acquired: boolean;
	previous?: TelegramOwnerState;
	reason: "free" | "same-session" | "stale" | "busy-owner";
} {
	if (!previous) {
		return { acquired: true, reason: "free" };
	}
	const currentPid = options?.currentPid ?? process.pid;
	if (previous.sessionId === claim.sessionId && previous.pid === currentPid) {
		return { acquired: true, previous, reason: "same-session" };
	}
	if (isTelegramOwnerStateStale(previous, options)) {
		return { acquired: true, previous, reason: "stale" };
	}
	return { acquired: false, previous, reason: "busy-owner" };
}

export function claimTelegramOwnership(claim: TelegramOwnerClaim): {
	acquired: boolean;
	previous?: TelegramOwnerState;
	reason: "free" | "same-session" | "stale" | "busy-owner";
} {
	const previous = readOwnerFile();
	const decision = evaluateTelegramOwnershipClaim(previous, claim);
	if (decision.acquired) {
		writeOwnerFile(claim);
	}
	return decision;
}

export function refreshTelegramOwnership(
	sessionId: string,
	patch: Partial<Pick<TelegramOwnerState, "busy" | "sessionFile" | "cwd">>,
): boolean {
	const current = readOwnerFile();
	if (
		!current ||
		current.sessionId !== sessionId ||
		current.pid !== process.pid ||
		isStale(current)
	)
		return false;
	writeOwnerFile({
		sessionId,
		sessionFile: patch.sessionFile ?? current.sessionFile,
		cwd: patch.cwd ?? current.cwd,
		busy: patch.busy ?? current.busy,
	});
	return true;
}

export function forceClaimTelegramOwnership(claim: TelegramOwnerClaim): TelegramOwnerState {
	return writeOwnerFile(claim);
}

export function releaseTelegramOwnership(sessionId: string): void {
	const current = readOwnerFile();
	if (!current || current.sessionId !== sessionId || current.pid !== process.pid) return;
	if (fs.existsSync(OWNER_FILE)) fs.rmSync(OWNER_FILE);
}

export function forceReleaseTelegramOwnership(): void {
	if (fs.existsSync(OWNER_FILE)) fs.rmSync(OWNER_FILE);
}

export function isTelegramOwner(sessionId: string): boolean {
	const current = readTelegramOwnerState();
	return current?.sessionId === sessionId && current.pid === process.pid;
}
