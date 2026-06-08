/**
 * Plan Extension
 *
 * Exposes plan components as a registered pi extension:
 *   - `plan_preview` tool — LLM can present phased plans for user review
 *   - `/plan` command — list and inspect saved plans
 *
 * Library functions and types are re-exported from plan-components
 * for use by other extensions.
 */

import path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
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
  // Register plan_preview tool
  pi.registerTool(planPreviewTool);

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
