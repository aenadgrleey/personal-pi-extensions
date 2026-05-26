import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { showLocalAskPrompt } from "../ask-components/index.js";
import { showLocalPlanDecision } from "../plan-components/index.js";
import { showLocalReviewPrompt } from "../review-components/index.js";
import type { PresentedInteraction, InteractionProvider } from "./hub.js";

export class LocalInteractionProvider implements InteractionProvider {
	readonly id = "local";

	isActive(ctx: ExtensionContext): boolean {
		return ctx.hasUI;
	}

	async present<T>(pending: PresentedInteraction<T>, ctx: ExtensionContext) {
		const abortController = new AbortController();

		void (async () => {
			switch (pending.record.interaction.kind) {
				case "ask": {
					const result = await showLocalAskPrompt(
						ctx,
						pending.record.interaction.questions,
						abortController.signal,
					);
					if (!abortController.signal.aborted) {
						pending.resolve({ providerId: this.id, value: result as T });
					}
					return;
				}
				case "plan": {
					const result = await showLocalPlanDecision(
						ctx,
						pending.record.interaction.params,
						abortController.signal,
					);
					if (!abortController.signal.aborted) {
						pending.resolve({ providerId: this.id, value: result as T });
					}
					return;
				}
				case "review": {
					const result = await showLocalReviewPrompt(
						ctx,
						pending.record.interaction.params,
						abortController.signal,
					);
					if (!abortController.signal.aborted) {
						pending.resolve({ providerId: this.id, value: result as T });
					}
					return;
				}
			}
		})();

		return () => abortController.abort();
	}
}
