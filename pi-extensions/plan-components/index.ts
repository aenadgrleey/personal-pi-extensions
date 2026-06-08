/**
 * Plan Extension — Library & Tool
 *
 * Provides `showPlanPreview()` — a function other extensions import directly
 * to display a phased plan to the user for review.
 *
 * Also registers a `plan_preview` tool so the LLM can call it too.
 *
 * The UI is split across two native pi surfaces:
 *   - renderCall  → full plan body rendered as an inline chat item (scrolls naturally)
 *   - showPlanPreview → ctx.ui.select() for the four choices (compact, no fight)
 *
 * Usage from another extension:
 *   import { showPlanPreview } from "../plan-components/index.js";
 *   const result = await showPlanPreview(ctx, { title, phases, context? });
 *   // result.action → "accepted" | "saved" | "refined" | "discarded"
 *
 * Plan files are persisted to .pi/plans/ on accept or save.
 */

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { Theme } from "@mariozechner/pi-coding-agent";
import { getInteractionBridge } from "../interaction-components/bridge.js";
import {
  Container,
  Spacer,
  Text,
  truncateToWidth,
  visibleWidth,
} from "../deps.js";
import { buildPlanText, savePlanToFile, type PlanPhase } from "./utils.js";

// Re-export models and utilities for consumers
export type { PlanPhase, PlanFile } from "./utils.js";
export {
  loadPlanFile,
  buildPlanFilePath,
  buildPlanSaveDir,
  buildPlanText,
  savePlanToFile,
} from "./utils.js";

// ── Constants ────────────────────────────────────────────────────────────

function formatResultLabel(icon: string, text: string, gap = 3): string {
  const iconBlock = truncateToWidth(icon, 2);
  const pad = Math.max(0, 2 - visibleWidth(iconBlock));
  return `${iconBlock}${" ".repeat(pad)}${" ".repeat(gap)}${text}`;
}

/** Choices shown in ctx.ui.select() — order matches SELECT_ACTIONS. */
const SELECT_LABELS = [
  "✅  Accept plan",
  "💾  Save for later",
  "✏️   Refine plan",
  "🗑️   Discard",
] as const;

const SELECT_ACTIONS = ["accepted", "saved", "refined", "discarded"] as const;

// ── Types ────────────────────────────────────────────────────────────────

export interface PlanPreviewParams {
  title: string;
  phases: PlanPhase[];
  context?: string;
}

export interface PlanPreviewResult {
  action: "accepted" | "saved" | "refined" | "discarded";
  title: string;
  phases: PlanPhase[];
  phaseNames: string[];
  planPath: string;
  planText: string;
  feedback?: string;
}

export interface PlanDecisionResult {
  action: "accepted" | "saved" | "refined" | "discarded";
  feedback?: string;
  cancelled?: boolean;
}

// ── Library function ─────────────────────────────────────────────────────

export async function showLocalPlanDecision(
  ctx: ExtensionContext,
  _params: PlanPreviewParams,
  signal?: AbortSignal,
): Promise<PlanDecisionResult> {
  if (!ctx.hasUI) {
    return { action: "accepted" };
  }

  ctx.ui.setWorkingMessage("User input...");
  try {
    const selected = await ctx.ui.select(
      "What would you like to do?",
      [...SELECT_LABELS],
      signal ? { signal } : undefined,
    );
    if (selected === undefined) {
      return { action: "discarded", cancelled: true };
    }
    const idx = SELECT_LABELS.indexOf(
      selected as (typeof SELECT_LABELS)[number],
    );
    const action = (
      idx >= 0 ? SELECT_ACTIONS[idx] : "discarded"
    ) as PlanDecisionResult["action"];

    const result: PlanDecisionResult = { action };
    if (action === "refined") {
      const feedback = await ctx.ui.editor(
        "How should the plan be refined?",
        "",
      );
      result.feedback = feedback?.trim() || undefined;
    }
    return result;
  } finally {
    ctx.ui.setWorkingMessage();
  }
}

export async function showPlanPreview(
  ctx: ExtensionContext,
  params: PlanPreviewParams,
): Promise<PlanPreviewResult> {
  const { title, phases } = params;
  const planText = buildPlanText(title, phases);
  const phaseNames = phases.map((p) => p.name);
  const bridge = getInteractionBridge();
  const decision = bridge
    ? await bridge.presentPlanDecision(ctx, params)
    : await showLocalPlanDecision(ctx, params);
  if (decision.action === "discarded" && !decision.cancelled) {
    setTimeout(() => ctx.abort(), 0);
  }
  const filePath =
    decision.action === "accepted" || decision.action === "saved"
      ? await savePlanToFile(ctx.cwd, title, phases)
      : "";
  return {
    ...decision,
    title,
    phases,
    phaseNames,
    planPath: filePath,
    planText,
  };
}

// ── Tool definition (for consumers to register) ──────────────────────────

const PlanPreviewToolParams = {
  type: "object",
  properties: {
    title: { type: "string", description: "Short title for the plan" },
    phases: {
      type: "array",
      description:
        "Plan phases. Each phase has a name and ordered steps. For single-phase plans, use one phase.",
      minItems: 1,
      maxItems: 20,
      items: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "Phase name (e.g. 'Schema & Resolvers')",
          },
          steps: {
            type: "array",
            description: "Ordered steps for this phase",
            minItems: 1,
            items: { type: "string", description: "A step within this phase" },
          },
        },
        required: ["name", "steps"],
        additionalProperties: false,
      },
    },
    context: {
      type: "string",
      description: "Optional background context shown above the phases",
    },
  },
  required: ["title", "phases"],
  additionalProperties: false,
} as const;

/** Tool definition consumers pass to pi.registerTool(). */
export const planPreviewTool = {
  name: "plan_preview",
  label: "Plan Preview",
  description:
    "Display a phased plan to the user for review. " +
    "Shows the plan in the selection prompt, then asks accept/save/refine/discard. " +
    "Works in any mode — designed for chain step interop. " +
    "On accept or save, the plan is persisted to .pi/plans/ and the file path + phase names are returned.",
  promptSnippet: "Display a phased plan to the user for review and approval",
  promptGuidelines: [
    "Use plan_preview when you have a plan ready and need user approval before proceeding.",
    "Organize work into named phases. Single-phase plans use one phase with all steps.",
    "The tool works in any mode — use it from chain steps that produce plans.",
    "On accept, the plan is saved and the path + phase names are returned for chain handoff.",
  ],
  parameters: PlanPreviewToolParams,

  async execute(
    _id: string,
    params: PlanPreviewParams,
    _signal: AbortSignal,
    _onUpdate: unknown,
    ctx: ExtensionContext,
  ) {
    const result = await showPlanPreview(ctx, params);

    const contentText = (() => {
      switch (result.action) {
        case "accepted":
          return `Plan accepted. Saved to: ${result.planPath}\nPhases: ${result.phaseNames.join(", ")}`;
        case "saved":
          return `Plan saved for later: ${result.planPath}`;
        case "refined":
          return result.feedback
            ? `User requested refinements:\n\n${result.feedback}\n\nPlease revise the plan based on this feedback and call plan_preview again.`
            : "User requested refinements but provided no feedback. Please ask what should change.";
        case "discarded":
          return "Plan discarded by user.";
      }
    })();

    return {
      content: [{ type: "text" as const, text: contentText }],
      details: result,
    };
  },

  /**
   * Renders the full plan body as an inline chat item.
   * Scrolls naturally with the conversation — no internal scroll widget.
   */
  renderCall(args: PlanPreviewParams, theme: Theme) {
    const title =
      typeof args.title === "string" && args.title.trim()
        ? args.title
        : "Untitled Plan";
    const phases = Array.isArray(args.phases)
      ? args.phases.filter((phase): phase is PlanPhase => Boolean(phase))
      : [];
    const totalSteps = phases.reduce(
      (sum, p) => sum + (p.steps?.length ?? 0),
      0,
    );

    const children: Array<Text | Spacer | undefined> = [
      new Text(theme.fg("accent", `📋 ${title}`), 0, 0),
    ];

    if (args.context?.trim()) {
      children.push(new Spacer(1));
      for (const line of args.context.trim().split("\n")) {
        children.push(new Text(theme.fg("muted", line), 0, 0));
      }
    }

    let globalStep = 1;
    for (const phase of phases) {
      children.push(new Spacer(1));
      const phaseLabel =
        phases.length > 1
          ? theme.fg("accent", theme.bold(`▸ ${phase.name}`))
          : theme.fg("accent", theme.bold("Steps:"));
      children.push(new Text(phaseLabel, 0, 0));
      for (const step of phase.steps ?? []) {
        children.push(
          new Text(theme.fg("text", `  ${globalStep}. ${step}`), 0, 0),
        );
        globalStep++;
      }
    }

    children.push(new Spacer(1));
    children.push(
      new Text(
        theme.fg("dim", `${phases.length} phase(s), ${totalSteps} step(s)`),
        0,
        0,
      ),
    );

    const container = new Container();
    for (const child of children.filter(
      (child): child is Text | Spacer => child !== undefined,
    )) {
      container.addChild(child);
    }
    return container;
  },

  renderResult(
    result: {
      details?: PlanPreviewResult;
      content: Array<{ type: string; text?: string }>;
    },
    _opts: { expanded: boolean; isPartial: boolean },
    theme: Theme,
  ) {
    const details = result.details;
    if (!details) {
      const text = result.content[0];
      return new Text(text?.type === "text" ? (text.text ?? "") : "", 0, 0);
    }
    switch (details.action) {
      case "accepted":
        return new Text(
          formatResultLabel("✓", "Accepted", 1) +
            theme.fg("dim", ` ${details.planPath}`),
          0,
          0,
        );
      case "saved":
        return new Text(
          formatResultLabel("💾", "Saved") + theme.fg("dim", details.planPath),
          0,
          0,
        );
      case "refined":
        return new Text(
          formatResultLabel("✏️", "Refinement requested", 1),
          0,
          0,
        );
      case "discarded":
        return new Text(formatResultLabel("🗑️", "Discarded"), 0, 0);
    }
  },
};
