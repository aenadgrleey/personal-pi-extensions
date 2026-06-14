/**
 * Plan handoff helpers
 *
 * "Hand off" is a `plan_preview` action that copies the just-accepted plan
 * to a stable `.pi/handoffs/<slug>.yaml` location and produces a short
 * pickup-prompt the caller can send to the agent (or paste into a fresh
 * session). It does NOT spawn a new pi process and does NOT compact context
 * — those are caller / user responsibilities.
 *
 * The plan YAML is the single handoff artifact. No markdown, no separate
 * handoff file format.
 */

import { execFile } from "node:child_process";
import { copyFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { buildHandoffPath, loadPlanFile } from "./utils.js";

/**
 * Short pickup prompt wrapped in a `<plan-handoff>` marker. The marker
 * explicitly frames the next turn as a new context scope (continuing the
 * plan at `handoffPath`, not branching into unrelated work), so the LLM
 * treats it as a hard context boundary rather than another user request.
 */
export function buildPickupPrompt(handoffPath: string, title: string): string {
  return [
    `<plan-handoff plan="${handoffPath}" title="${title}">`,
    `You are continuing prior work. The previous turn is complete; from this point on, focus exclusively on the plan above.`,
    `Start with Phase 1, step 1. Read the plan file, then execute it phase by phase, reporting back after each phase.`,
    `Do not branch into unrelated work. Treat the plan as the sole task in scope until it is done or you hit a clear blocker.`,
    `</plan-handoff>`,
  ].join("\n");
}

export interface CreateHandoffFileResult {
  handoffPath: string;
  pickupPrompt: string;
}

/**
 * Copy the plan YAML at `sourcePlanPath` to a stable handoff location
 * `.pi/handoffs/<slug>.yaml` (overwrites if it exists). Returns the new
 * path and a pickup prompt.
 *
 * The source plan is read first to derive a deterministic slug from its
 * title; falls back to the basename of the source path if reading fails.
 */
export async function createHandoffFile(
  cwd: string,
  sourcePlanPath: string,
): Promise<CreateHandoffFileResult> {
  let title = path.basename(sourcePlanPath, ".yaml");
  try {
    const plan = await loadPlanFile(sourcePlanPath);
    if (plan.title) title = plan.title;
  } catch {
    // Keep the basename fallback; the path itself is the durable handle.
  }

  const handoffPath = buildHandoffPath(cwd, title);
  await mkdir(path.dirname(handoffPath), { recursive: true });
  await copyFile(sourcePlanPath, handoffPath);

  return { handoffPath, pickupPrompt: buildPickupPrompt(handoffPath, title) };
}

/**
 * Best-effort macOS clipboard write via `pbcopy`. Falls back to a
 * stderr log on non-macOS or on failure so the caller can still rely
 * on the pickup prompt being available somewhere.
 */
export function copyToClipboard(text: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile("pbcopy", { timeout: 3000, input: text }, (err) => {
      if (err) {
        console.error(`[handoff] pbcopy failed; pickup prompt:\n${text}`);
      }
      resolve(!err);
    });
  });
}

// ── Context cut: marker detection + filter ────────────────────────────────

/**
 * The substring the `context` filter looks for inside a user message to
 * recognize the pickup prompt as a handoff boundary. The pickup prompt
 * wraps its body in `<plan-handoff plan="…" title="…">…</plan-handoff>`,
 * so the opening tag is a stable handle that survives whitespace/quote
 * variations in `title` / `path`.
 */
export const HANDOFF_MARKER = "<plan-handoff";

interface UserMessageLike {
  role?: string;
  content?: unknown;
}

/** Find the index of the last user message whose text contains the marker. */
export function findLastHandoffIndex(messages: readonly unknown[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as UserMessageLike;
    if (!m || m.role !== "user") continue;
    const text = extractText(m.content);
    if (text && text.includes(HANDOFF_MARKER)) return i;
  }
  return -1;
}

function extractText(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    for (const part of content) {
      if (
        part &&
        typeof part === "object" &&
        (part as { type?: string }).type === "text" &&
        typeof (part as { text?: unknown }).text === "string"
      ) {
        return (part as { text: string }).text;
      }
    }
  }
  return undefined;
}

/**
 * Drop everything in `messages` before the last `<plan-handoff>` marker
 * user message. Used by the plan extension's `pi.on("context")` handler
 * to give the LLM a fresh context scope after a handoff, while keeping
 * the full history on disk (so `/resume` / tree navigation still work).
 *
 * Returns the original array unchanged if no marker is found.
 */
export function filterMessagesBeforeHandoff<T>(messages: readonly T[]): T[] {
  const idx = findLastHandoffIndex(messages);
  if (idx === -1) return messages.slice();
  return messages.slice(idx);
}
