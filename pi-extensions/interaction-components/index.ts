/**
 * Public surface of the interaction-components package.
 *
 * Re-exports the bridge + hub types, the local provider, and the
 * pub/sub event hook used by `interaction-notifier` and friends.
 */

export type {
  BridgeAskAnswer,
  BridgeAskOption,
  BridgeAskQuestion,
  BridgeAskResult,
  BridgeNotification,
  InteractionBridge,
} from "./bridge.js";

export { getInteractionBridge, setInteractionBridge } from "./bridge.js";

export type { InteractionProvider, PresentedInteraction } from "./hub.js";
export { InteractionHub } from "./hub.js";
export { LocalInteractionProvider } from "./local-provider.js";

export type {
  AskInteraction,
  InteractionResolution,
  PendingInteractionRecord,
  PersistedPendingInteraction,
  SharedInteraction,
  SharedInteractionResults,
} from "./types.js";

export type {
  InteractionEvent,
  InteractionKind,
  InteractionListener,
} from "./notify.js";
export { addInteractionListener, emitInteraction } from "./notify.js";
