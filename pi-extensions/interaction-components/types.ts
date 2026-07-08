import type { BridgeAskAnswer, BridgeAskQuestion } from "./bridge.js";

export interface AskInteraction {
  kind: "ask";
  questions: BridgeAskQuestion[];
}

export type SharedInteraction = AskInteraction;

export interface PendingInteractionRecord {
  id: string;
  createdAt: string;
  interaction: SharedInteraction;
}

export interface InteractionResolution<T> {
  providerId: string;
  value: T;
}

export interface PersistedPendingInteraction {
  interactionId: string;
  kind: SharedInteraction["kind"];
  activeMessageId?: number;
  promptMessageIds: number[];
  helperMessageIds: number[];
  currentQuestionIndex?: number;
  answers?: BridgeAskAnswer[];
  createdAt: string;
}

export interface SharedInteractionResults {
  ask: { answers: BridgeAskAnswer[]; cancelled: boolean };
}
