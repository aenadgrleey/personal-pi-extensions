import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type {
  BridgeAskQuestion,
  BridgeAskResult,
  BridgeNotification,
  BridgePlanDecisionResult,
  BridgePlanPreviewParams,
  BridgeReviewPromptParams,
  BridgeReviewPromptResult,
  InteractionBridge,
} from "./bridge.js";
import type {
  InteractionResolution,
  PendingInteractionRecord,
  SharedInteraction,
} from "./types.js";

export interface PresentedInteraction<T = unknown> {
  record: PendingInteractionRecord;
  resolve: (resolution: InteractionResolution<T>) => void;
}

export interface InteractionProvider {
  id: string;
  isActive(ctx: ExtensionContext): boolean;
  present<T>(
    pending: PresentedInteraction<T>,
    ctx: ExtensionContext,
  ): Promise<(() => void | Promise<void>) | void>;
  onResolved?<T>(
    record: PendingInteractionRecord,
    resolution: InteractionResolution<T>,
  ): Promise<void>;
  notify?(notification: BridgeNotification): Promise<void>;
}

interface PendingRuntime<T> {
  record: PendingInteractionRecord;
  resolvePromise: (resolution: InteractionResolution<T>) => void;
  cleanup: Array<() => void | Promise<void>>;
  settled: boolean;
  activeProviderIds: string[];
  cancelledProviderIds: Set<string>;
}

function makeInteractionId(): string {
  return `ti_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function isProviderCancellation(
  interaction: SharedInteraction,
  value: unknown,
): boolean {
  switch (interaction.kind) {
    case "ask":
      return Boolean(
        value &&
        typeof value === "object" &&
        "cancelled" in value &&
        value.cancelled === true,
      );
    case "plan":
      return Boolean(
        value &&
        typeof value === "object" &&
        "cancelled" in value &&
        value.cancelled === true,
      );
    case "review":
      return value === undefined;
  }
}

export class InteractionHub implements InteractionBridge {
  private readonly pending = new Map<string, PendingRuntime<unknown>>();
  private readonly providers: InteractionProvider[];

  constructor(providers: InteractionProvider[]) {
    this.providers = providers;
  }

  private async present<T>(
    ctx: ExtensionContext,
    interaction: SharedInteraction,
  ): Promise<T> {
    const record: PendingInteractionRecord = {
      id: makeInteractionId(),
      createdAt: new Date().toISOString(),
      interaction,
    };

    const activeProviders = this.providers.filter((provider) =>
      provider.isActive(ctx),
    );
    if (activeProviders.length === 0) {
      throw new Error(
        `No active interaction providers for ${interaction.kind}`,
      );
    }

    const resolution = await new Promise<InteractionResolution<T>>(
      (resolve, reject) => {
        const pending: PendingRuntime<T> = {
          record,
          resolvePromise: resolve,
          cleanup: [],
          settled: false,
          activeProviderIds: activeProviders.map((provider) => provider.id),
          cancelledProviderIds: new Set<string>(),
        };
        this.pending.set(record.id, pending as PendingRuntime<unknown>);

        void (async () => {
          try {
            for (const provider of activeProviders) {
              const dispose = await provider.present<T>(
                {
                  record,
                  resolve: (next) => this.resolve(record.id, next),
                },
                ctx,
              );
              if (dispose) pending.cleanup.push(dispose);
            }
          } catch (error) {
            this.pending.delete(record.id);
            reject(error);
          }
        })();
      },
    );

    const stored = this.pending.get(record.id) as PendingRuntime<T> | undefined;
    this.pending.delete(record.id);
    if (stored) {
      for (const cleanup of stored.cleanup) {
        await cleanup();
      }
    }
    for (const provider of activeProviders) {
      await provider.onResolved?.(record, resolution);
    }
    return resolution.value;
  }

  private resolve<T>(
    interactionId: string,
    resolution: InteractionResolution<T>,
  ): void {
    const pending = this.pending.get(interactionId) as
      | PendingRuntime<T>
      | undefined;
    if (!pending || pending.settled) return;
    if (isProviderCancellation(pending.record.interaction, resolution.value)) {
      pending.cancelledProviderIds.add(resolution.providerId);
      if (pending.cancelledProviderIds.size < pending.activeProviderIds.length)
        return;
    }
    pending.settled = true;
    pending.resolvePromise(resolution);
  }

  async presentAsk(
    ctx: ExtensionContext,
    questions: BridgeAskQuestion[],
  ): Promise<BridgeAskResult> {
    return this.present<BridgeAskResult>(ctx, { kind: "ask", questions });
  }

  async presentPlanDecision(
    ctx: ExtensionContext,
    params: BridgePlanPreviewParams,
  ): Promise<BridgePlanDecisionResult> {
    return this.present<BridgePlanDecisionResult>(ctx, {
      kind: "plan",
      params,
    });
  }

  async presentReview(
    ctx: ExtensionContext,
    params: BridgeReviewPromptParams,
  ): Promise<BridgeReviewPromptResult | undefined> {
    return this.present<BridgeReviewPromptResult | undefined>(ctx, {
      kind: "review",
      params,
    });
  }

  async notifyCompletion(notification: BridgeNotification): Promise<void> {
    for (const provider of this.providers) {
      await provider.notify?.(notification);
    }
  }
}
