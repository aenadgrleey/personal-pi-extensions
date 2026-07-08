import type { ExtensionContext } from "@mariozechner/pi-coding-agent";

export interface BridgeAskOption {
  label: string;
  description?: string;
}

export interface BridgeAskQuestion {
  id: string;
  question: string;
  context?: string;
  options: BridgeAskOption[];
  defaultIndex?: number;
  allowOther?: boolean;
}

export interface BridgeAskAnswer {
  id: string;
  answer: string;
  wasCustom: boolean;
  index?: number;
}

export interface BridgeAskResult {
  answers: BridgeAskAnswer[];
  cancelled: boolean;
}

export interface BridgeNotification {
  title: string;
  body: string;
}

export interface InteractionBridge {
  presentAsk(
    ctx: ExtensionContext,
    questions: BridgeAskQuestion[],
  ): Promise<BridgeAskResult>;
  notifyCompletion(notification: BridgeNotification): Promise<void>;
}

// Pi loads extensions through jiti, which gives each extension its own module cache.
// Store the active bridge on globalThis so interaction-aware extensions
// can still see the Telegram-owned bridge instance.
const BRIDGE_GLOBAL_KEY = "__personalAiToolsInteractionBridge__";

type InteractionBridgeGlobal = typeof globalThis & {
  [BRIDGE_GLOBAL_KEY]?: InteractionBridge;
};

function getBridgeGlobal(): InteractionBridgeGlobal {
  return globalThis as InteractionBridgeGlobal;
}

export function getInteractionBridge(): InteractionBridge | undefined {
  return getBridgeGlobal()[BRIDGE_GLOBAL_KEY];
}

export function setInteractionBridge(
  bridge: InteractionBridge | undefined,
): void {
  const bridgeGlobal = getBridgeGlobal();
  if (bridge) {
    bridgeGlobal[BRIDGE_GLOBAL_KEY] = bridge;
    return;
  }
  delete bridgeGlobal[BRIDGE_GLOBAL_KEY];
}
