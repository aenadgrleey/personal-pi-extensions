/**
 * Ask Extension
 *
 * Exposes the ask tool for LLM-driven user questions.
 * Component and tool definition live in ask-components/.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { askTool } from "../ask-components/index.js";

// Re-export for consumers
export type {
  AskOption,
  Question,
  Answer,
  AskResult,
} from "../ask-components/index.js";
export { AskParams, askTool } from "../ask-components/index.js";

export default function (pi: ExtensionAPI) {
  pi.registerTool(askTool);
}
