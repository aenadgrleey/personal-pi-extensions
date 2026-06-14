/**
 * Plan Extension
 *
 * Exposes plan components as a registered pi extension:
 *   - `plan_preview` tool — LLM can present phased plans for user review
 *   - `/plan` command — list and inspect saved plans
 *   - Handoff: the "📤 Hand off" action in `plan_preview` queues a
 *     `<plan-handoff>` pickup prompt for after the current turn and a
 *     `pi.on("context")` filter cuts the LLM-facing message history at
 *     that marker. Full history stays on disk for /resume / tree nav.
 *
 * Library functions and types are re-exported from plan-components
 * for use by other extensions.
 */

import path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
  filterMessagesBeforeHandoff,
  buildPlanSaveDir,
  buildPlanText,
  loadPlanFile,
  planPreviewTool,
} from "../plan-components/index.js";

// Re-export for consumers
export type { PlanFile, PlanPhase } from "../plan-components/index.js";
export {
  buildPlanText,
  buildPlanFilePath,
  buildPlanSaveDir,
  loadPlanFile,
  savePlanToFile,
  showPlanPreview,
} from "../plan-components/index.js";

// ── Helpers ──────────────────────────────────────────────────────────────

async function listPlanFiles(cwd: string): Promise<string[]> {
  const { readdir } = await import("node:fs/promises");
  const dir = buildPlanSaveDir(cwd);
  try {
    const files = await readdir(dir);
    return files
      .filter((f) => f.endsWith("-plan.yaml"))
      .sort()
      .reverse();
  } catch {
    return [];
  }
}

// ── Extension ────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  // Wrap plan_preview so we can react to the "Hand off" action: after the
  // tool returns, send the pickup prompt as a real user message (same
  // session, no compaction) and notify the UI. Closes over `pi` because
  // tool execute() only receives `ctx`, not the ExtensionAPI.
  const wrappedPlanTool = {
    ...planPreviewTool,
    async execute(
      toolCallId: string,
      params: Parameters<typeof planPreviewTool.execute>[1],
      signal: Parameters<typeof planPreviewTool.execute>[2],
      onUpdate: Parameters<typeof planPreviewTool.execute>[3],
      ctx: Parameters<typeof planPreviewTool.execute>[4],
    ) {
      const result = await planPreviewTool.execute(
        toolCallId,
        params,
        signal,
        onUpdate,
        ctx,
      );
      const details = result.details as
        | { action?: string; pickupPrompt?: string; handoffPath?: string }
        | undefined;
      if (details?.action === "handed_off" && details.pickupPrompt) {
        ctx.ui.notify(
          "📤 Plan handed off — pickup prompt queued. Next turn starts with a clean context scope.",
          "info",
        );
        // `followUp` queues the pickup prompt for after the current turn
        // ends, so the plan_preview result stays intact in this turn and
        // the prompt arrives as the first user input of the next one. The
        // pi.on("context") filter (below) cuts everything before the
        // <plan-handoff> marker from what the LLM actually sees.
        await pi.sendUserMessage(details.pickupPrompt, {
          deliverAs: "followUp",
        });
      }
      return result;
    },
  };

  pi.registerTool(wrappedPlanTool);

  // Context cut at the last <plan-handoff> marker. The pickup prompt
  // queued by the wrapped plan_preview tool (above) carries that tag;
  // when the next turn starts, this handler drops every message that
  // appeared before the latest marker so the LLM sees a clean scope.
  // The full history remains on disk and is unaffected for /resume.
  pi.on("context", async (event) => {
    const filtered = filterMessagesBeforeHandoff(event.messages);
    if (filtered.length === event.messages.length) return;
    return { messages: filtered };
  });

  // Register /plan command
  pi.registerCommand("plan", {
    description:
      "Manage saved plans (list, view). Usage: /plan [list|view <path>]",
    async handler(args, ctx) {
      const parts = args.trim().split(/\s+/);
      const sub = parts[0] ?? "list";

      if (sub === "list") {
        const files = await listPlanFiles(ctx.cwd);
        if (files.length === 0) {
          ctx.ui.notify("No saved plans found in .pi/plans/", "info");
          return;
        }

        const items = await Promise.all(
          files.map(async (f) => {
            const fullPath = path.join(buildPlanSaveDir(ctx.cwd), f);
            try {
              const plan = await loadPlanFile(fullPath);
              const stepCount = plan.phases.reduce(
                (s, p) => s + p.steps.length,
                0,
              );
              return `  ${f} — ${plan.title} (${plan.phases.length} phase(s), ${stepCount} step(s))`;
            } catch {
              return `  ${f} — (unreadable)`;
            }
          }),
        );

        ctx.ui.notify(`Saved plans:\n${items.join("\n")}`, "info");
        return;
      }

      if (sub === "view") {
        const target = parts.slice(1).join(" ");
        if (!target) {
          ctx.ui.notify("Usage: /plan view <filename-or-path>", "error");
          return;
        }

        const fullPath = target.includes(path.sep)
          ? target
          : path.join(buildPlanSaveDir(ctx.cwd), target);

        try {
          const plan = await loadPlanFile(fullPath);
          const text = buildPlanText(plan.title, plan.phases);
          ctx.ui.notify(text, "info");
        } catch {
          ctx.ui.notify(`Could not load plan: ${fullPath}`, "error");
        }
        return;
      }

      ctx.ui.notify(
        `Unknown subcommand "${sub}". Use: /plan [list|view <path>]`,
        "error",
      );
    },
  });
}
