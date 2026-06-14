/**
 * Interaction event hook
 *
 * Lightweight pub/sub for "an interaction is about to be presented to the
 * user" events. The three shared entry points (`showPlanPreview` in
 * plan-components, `showAskPrompt` in ask-components, `showReviewPrompt`
 * in review-components) call `emitInteraction` at the start — covering
 * both the bridge path and the local-fallback path in one call site per
 * kind.
 *
 * The store lives on `globalThis` so listeners registered by any
 * extension (regardless of module load order) see the same events.
 * `interaction-notifier` is the canonical consumer.
 */

export type InteractionKind = "ask" | "plan" | "review";

export interface InteractionEvent {
  kind: InteractionKind;
  summary: string;
  timestamp: string;
}

export type InteractionListener = (event: InteractionEvent) => void;

const GLOBAL_KEY = "__personalAiToolsInteractionListeners__";

type ListenerGlobal = typeof globalThis & {
  [GLOBAL_KEY]?: Set<InteractionListener>;
};

function getStore(): Set<InteractionListener> {
  const g = globalThis as ListenerGlobal;
  if (!g[GLOBAL_KEY]) {
    g[GLOBAL_KEY] = new Set();
  }
  return g[GLOBAL_KEY];
}

/** Subscribe to interaction events. Returns an unsubscribe function. */
export function addInteractionListener(
  listener: InteractionListener,
): () => void {
  const store = getStore();
  store.add(listener);
  return () => {
    store.delete(listener);
  };
}

/** Fire an event to all current listeners. Safe with no listeners. */
export function emitInteraction(event: InteractionEvent): void {
  const store = getStore();
  for (const listener of store) {
    try {
      listener(event);
    } catch (err) {
      console.error("[interaction-notify] listener threw:", err);
    }
  }
}

/** Test/diagnostic helper. Returns the number of active listeners. */
export function _listenerCount(): number {
  return getStore().size;
}
