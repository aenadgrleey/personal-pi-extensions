/**
 * Simple macOS Notification Extension
 *
 * Sends a desktop notification when the agent finishes.
 * Uses osascript (always available on macOS).
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { CustomEditor } from "./deps.js";
import { execFile } from "node:child_process";

function notify(
  title: string,
  message: string,
  sound?: string,
): Promise<boolean> {
  const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  let script = `display notification "${esc(message)}" with title "${esc(title)}"`;
  if (sound) script += ` sound name "${sound}"`;
  return new Promise((ok) => {
    execFile("osascript", ["-e", script], { timeout: 5000 }, (err) => ok(!err));
  });
}

export default function (pi: ExtensionAPI) {
  const config = { autoNotify: true, sound: "Glass", title: "pi" };
  let aborted = false;
  let notifyTimer: ReturnType<typeof setTimeout> | null = null;

  function cancelPending() {
    if (notifyTimer) {
      clearTimeout(notifyTimer);
      notifyTimer = null;
    }
  }

  pi.on("session_start", async (_event, ctx) => {
    if (!ctx.hasUI) return;
    ctx.ui.setEditorComponent(
      (tui, theme, keybindings) =>
        new (class extends CustomEditor {
          handleInput(data: string): void {
            cancelPending();
            super.handleInput(data);
          }
        })(tui, theme, keybindings),
    );
  });

  pi.on("agent_start", async () => {
    cancelPending();
    aborted = false;
  });

  pi.on("agent_end", async (_event, _ctx) => {
    if (!config.autoNotify || aborted) return;
    notifyTimer = setTimeout(async () => {
      notifyTimer = null;
      await notify(config.title, "Done — awaiting input", config.sound);
    }, 5000);
  });

  pi.on("input", async () => {
    cancelPending();
  });

  pi.on("session_shutdown", async () => {
    aborted = true;
    cancelPending();
  });

  pi.registerCommand("notify", {
    description: "Send a macOS desktop notification",
    handler: async (args: string, ctx) => {
      const message = args?.trim() || "Hello from pi!";
      const ok = await notify(config.title, message, config.sound);
      if (ctx.hasUI)
        ctx.ui.notify(ok ? "📬 Sent" : "❌ Failed", ok ? "info" : "error");
    },
  });

  pi.registerCommand("notify-config", {
    description: "Toggle auto-notify on/off",
    handler: async (_args: string, ctx) => {
      config.autoNotify = !config.autoNotify;
      ctx.ui.notify(`Auto-notify: ${config.autoNotify ? "ON" : "OFF"}`, "info");
    },
  });
}
