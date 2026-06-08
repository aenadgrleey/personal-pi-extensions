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

export interface BridgePlanPhase {
  name: string;
  steps: string[];
}

export interface BridgePlanPreviewParams {
  title: string;
  phases: BridgePlanPhase[];
  context?: string;
}

export interface BridgePlanDecisionResult {
  action: "accepted" | "saved" | "refined" | "discarded";
  feedback?: string;
  cancelled?: boolean;
}

export interface BridgeReviewPromptParams {
  decision: string;
  summary: string;
  context?: string;
}

export interface BridgeReviewPromptResult {
  decision: "continue" | "redefine";
  feedback?: string;
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
  presentPlanDecision(
    ctx: ExtensionContext,
    params: BridgePlanPreviewParams,
  ): Promise<BridgePlanDecisionResult>;
  presentReview(
    ctx: ExtensionContext,
    params: BridgeReviewPromptParams,
  ): Promise<BridgeReviewPromptResult | undefined>;
  notifyCompletion(notification: BridgeNotification): Promise<void>;
}

// Pi loads extensions through jiti, which gives each extension its own module cache.
// Store the active bridge on globalThis so ask/plan/review tools in separate extensions
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
