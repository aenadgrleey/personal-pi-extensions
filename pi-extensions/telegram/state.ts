import { SessionManager, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TelegramStateSnapshot } from "./types.js";

export const TELEGRAM_STATE_TYPE = "telegram-state";
const STATE_VERSION = 2 as const;

function clone<T>(value: T): T {
	return JSON.parse(JSON.stringify(value)) as T;
}

export function createEmptyTelegramState(): TelegramStateSnapshot {
	return {
		version: STATE_VERSION,
		outboundMessageIds: [],
		inboundMessageIds: [],
		pending: [],
		attachments: [],
		steering: [],
	};
}

function isSnapshot(value: unknown): value is TelegramStateSnapshot {
	if (!value || typeof value !== "object") return false;
	const candidate = value as Partial<TelegramStateSnapshot>;
	return (
		candidate.version === STATE_VERSION &&
		Array.isArray(candidate.outboundMessageIds) &&
		Array.isArray(candidate.inboundMessageIds)
	);
}

export function loadTelegramState(
	sessionManager: ExtensionContext["sessionManager"],
): TelegramStateSnapshot {
	const entry = [...sessionManager.getEntries()]
		.reverse()
		.find(
			(item) => item.type === "custom" && item.customType === TELEGRAM_STATE_TYPE,
		) as { data?: unknown } | undefined;

	if (!entry?.data || !isSnapshot(entry.data)) return createEmptyTelegramState();
	return clone(entry.data);
}

export function loadTelegramStateFromSessionFile(
	sessionFile: string | undefined,
): TelegramStateSnapshot {
	if (!sessionFile) return createEmptyTelegramState();
	try {
		const session = SessionManager.open(sessionFile);
		return loadTelegramState(session);
	} catch {
		return createEmptyTelegramState();
	}
}

export function mergeTelegramStates(...states: TelegramStateSnapshot[]): TelegramStateSnapshot {
	const merged = createEmptyTelegramState();
	let lastUpdateId = 0;
	for (const state of states) {
		lastUpdateId = Math.max(lastUpdateId, state.lastUpdateId ?? 0);
		merged.outboundMessageIds.push(...state.outboundMessageIds);
		merged.inboundMessageIds.push(...state.inboundMessageIds);
		merged.pending.push(...state.pending);
		merged.attachments.push(...state.attachments);
		merged.steering.push(...state.steering);
		if (state.armedSkill) {
			merged.armedSkill = state.armedSkill;
		}
	}
	merged.outboundMessageIds = [...new Set(merged.outboundMessageIds)];
	merged.inboundMessageIds = [...new Set(merged.inboundMessageIds)];
	if (lastUpdateId > 0) merged.lastUpdateId = lastUpdateId;
	return merged;
}

export function trimTrackedState<T>(items: T[], maxItems = 20): T[] {
	if (items.length <= maxItems) return items;
	return items.slice(items.length - maxItems);
}
