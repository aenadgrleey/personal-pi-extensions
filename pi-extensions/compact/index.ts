/**
 * Compact Tools Extension
 *
 * read  — hides the custom result, leaving the system output.
 * edit  — shows only the edit count and size tag.
 * write — shows only a confirmation.
 * memory/session search tools — compact long result payloads into short summaries.
 * skill view — show which skill was loaded.
 *
 * The LLM always receives full content/results for the built-in tool overrides.
 */

import type {
  ExtensionAPI,
  ReadToolDetails,
  Theme,
} from "@mariozechner/pi-coding-agent";
import { createEditTool, createReadTool, createWriteTool, Text } from "../deps.js";
import type { Component } from "@mariozechner/pi-tui";

function countLines(text: string): number {
  let n = 0;
  for (const ch of text) if (ch === "\n") n++;
  return n + 1;
}

const LARGE_EDIT_THRESHOLD = 10;
type ReadParams = Parameters<ReturnType<typeof createReadTool>["execute"]>[1];
type EditParams = Parameters<ReturnType<typeof createEditTool>["execute"]>[1];
type WriteParams = Parameters<ReturnType<typeof createWriteTool>["execute"]>[1];

interface RenderContext {
  args: Record<string, unknown>;
  lastComponent: Component | undefined;
  isError: boolean;
  cwd: string;
}

function ensureText(last: Component | undefined): Text {
  return (last as Text | undefined) ?? new Text("", 0, 0);
}

const toolCache = new Map<
  string,
  {
    read: ReturnType<typeof createReadTool>;
    edit: ReturnType<typeof createEditTool>;
    write: ReturnType<typeof createWriteTool>;
  }
>();

function getBuiltInTools(cwd: string) {
  let tools = toolCache.get(cwd);
  if (!tools) {
    tools = {
      read: createReadTool(cwd),
      edit: createEditTool(cwd),
      write: createWriteTool(cwd),
    };
    toolCache.set(cwd, tools);
  }
  return tools;
}

function isMemoryRelatedTool(toolName: string): boolean {
  return /memory|session/i.test(toolName);
}

function getViewedSkillName(input: Record<string, unknown>): string | undefined {
  const fileName = typeof input.file_name === "string" ? input.file_name : undefined;
  const name = typeof input.name === "string" ? input.name : undefined;
  const raw = name ?? fileName;
  if (!raw) return undefined;
  return raw.replace(/\.md$/i, "");
}

function compactTextContent(content: Array<{ type: string; text?: string }>): string | undefined {
  const text = content
    .filter((part): part is { type: "text"; text?: string } => part.type === "text")
    .map((part) => part.text ?? "")
    .join("\n")
    .trim();

  if (!text) return undefined;

  const lines = text.split("\n").filter(Boolean);
  const firstLine = lines[0] ?? text;
  if (lines.length <= 1) {
    return firstLine.length > 120 ? `${firstLine.slice(0, 117)}...` : firstLine;
  }

  const extra = lines.length - 1;
  const head = firstLine.length > 120 ? `${firstLine.slice(0, 117)}...` : firstLine;
  return `${head} (+${extra} more line${extra === 1 ? "" : "s"})`;
}

export default function (pi: ExtensionAPI) {
  const originalTools = getBuiltInTools(process.cwd());

  pi.on("tool_result", (event) => {
    if (event.isError) return;

    if (event.toolName === "skill" && event.input.action === "view") {
      const skillName = getViewedSkillName(event.input);
      if (!skillName) return;

      return {
        content: [{ type: "text" as const, text: `Loaded skill: ${skillName}` }],
      };
    }

    if (!isMemoryRelatedTool(event.toolName)) return;

    const summary = compactTextContent(event.content);
    if (!summary) return;

    return {
      content: [{ type: "text" as const, text: summary }],
    };
  });

  // Compact read: keep only the system output
  pi.registerTool({
    name: "read",
    label: "read",
    description: originalTools.read.description,
    parameters: originalTools.read.parameters,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      return getBuiltInTools(ctx.cwd).read.execute(
        toolCallId,
        params as ReadParams,
        signal,
        onUpdate,
      );
    },
    renderResult(
      _result: { details: ReadToolDetails | undefined },
      _options: { expanded: boolean; isPartial: boolean },
      _theme: Theme,
      context: RenderContext,
    ): Component {
      const component = ensureText(context.lastComponent);
      component.setText("");
      return component;
    },
  } as Parameters<typeof pi.registerTool>[0]);

  // Compact edit: show only the edit summary
  pi.registerTool({
    name: "edit",
    label: "edit",
    description: originalTools.edit.description,
    parameters: originalTools.edit.parameters,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      return getBuiltInTools(ctx.cwd).edit.execute(
        toolCallId,
        params as EditParams,
        signal,
        onUpdate,
      );
    },
    renderResult(
      _result: unknown,
      _options: { expanded: boolean; isPartial: boolean },
      theme: Theme,
      context: RenderContext,
    ): Component {
      const component = ensureText(context.lastComponent);
      const args = context.args as
        | {
            edits?: Array<{ oldText?: string; newText?: string }>;
          }
        | undefined;

      const editCount = args?.edits?.length ?? 0;
      const editStr = editCount === 1 ? "1 edit" : `${editCount} edits`;
      const maxLines = args?.edits?.reduce(
        (max, e) =>
          Math.max(
            max,
            countLines(e.oldText ?? ""),
            countLines(e.newText ?? ""),
          ),
        0,
      );
      const largeTag =
        (maxLines ?? 0) > LARGE_EDIT_THRESHOLD
          ? ` (>${LARGE_EDIT_THRESHOLD} lines)`
          : "";
      const icon = context.isError
        ? theme.fg("error", "✗")
        : theme.fg("success", "✓");

      component.setText(
        `${icon}${theme.fg("toolTitle", " edit")}
${theme.fg("dim", `(${editStr}${largeTag})`)}`,
      );
      return component;
    },
  } as Parameters<typeof pi.registerTool>[0]);

  // Compact write: show only a confirmation
  pi.registerTool({
    name: "write",
    label: "write",
    description: originalTools.write.description,
    parameters: originalTools.write.parameters,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      return getBuiltInTools(ctx.cwd).write.execute(
        toolCallId,
        params as WriteParams,
        signal,
        onUpdate,
      );
    },
    renderResult(
      _result: unknown,
      _options: { expanded: boolean; isPartial: boolean },
      theme: Theme,
      context: RenderContext,
    ): Component {
      const component = ensureText(context.lastComponent);

      const icon = context.isError
        ? theme.fg("error", "✗")
        : theme.fg("success", "✓");

      component.setText(`${icon}${theme.fg("toolTitle", " write")}`);
      return component;
    },
  } as Parameters<typeof pi.registerTool>[0]);
}
