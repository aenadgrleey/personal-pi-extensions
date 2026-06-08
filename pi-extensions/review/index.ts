/**
 * Review Extension
 *
 * Exposes a decision-review tool and the reusable review prompt UI.
 * UI, schema, and tool definition live in review-components/.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { reviewTool } from "../review-components/index.js";

export type {
  ChainReviewResult,
  ReviewPromptParams,
  ReviewPromptResult,
  ReviewToolDetails,
} from "../review-components/index.js";
export {
  showChainReview,
  showReviewPrompt,
  reviewTool,
} from "../review-components/index.js";

export default function (pi: ExtensionAPI) {
  pi.registerTool(reviewTool);
}
