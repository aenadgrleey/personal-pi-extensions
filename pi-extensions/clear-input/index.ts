/**
 * Clear Input — wipes the prompt editor on `Cmd+Shift+R` (pi: `ctrl+shift+r`).
 *
 * The built-in `app.clear` action is bound to `ctrl+c` by default, which clashes
 * with the host terminal's "copy" / interrupt in many setups. This extension
 * exposes a non-conflicting chord that does the same job — set editor text to
 * an empty string — without touching the existing `app.clear` binding.
 *
 * Also registers `/clear-input` as a slash-command fallback for callers who
 * can't trigger shortcuts (RPC mode, print mode, etc.).
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const SHORTCUT = "ctrl+shift+r";

export default function (pi: ExtensionAPI) {
  pi.registerShortcut(SHORTCUT, {
    description: "Clear the prompt editor",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) return;
      const previous = ctx.ui.getEditorText();
      if (previous === "") return; // already empty — stay quiet
      ctx.ui.setEditorText("");
    },
  });

  pi.registerCommand("clear-input", {
    description: "Clear the prompt editor",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) return;
      ctx.ui.setEditorText("");
    },
  });
}
