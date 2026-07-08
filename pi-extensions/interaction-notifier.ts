/**
 * Interaction Notifier Extension
 *
 * Sends macOS desktop notifications (via `osascript`) when the agent is
 * about to present an ask prompt to the user. Subscribes to the
 * pub/sub event hook in `pi-extensions/interaction-components/notify.ts`,
 * which is fired by ask-components — covering both the bridge path and the
 * local-fallback path.
 *
 * Config:
 *   - enabled: master toggle
 *   - kinds: per-kind toggle (ask)
 *   - sounds: per-kind macOS sound name
 *
 * Commands:
 *   - /notif-config           → toggle master enabled
 *   - /notif-config ask       → toggle ask notifications
 *
 * Independent of `notify.ts` (which fires on agent_end). Both can run
 * side by side.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { execFile } from "node:child_process";
import { addInteractionListener } from "./interaction-components/notify.js";
import type {
  InteractionEvent,
  InteractionKind,
} from "./interaction-components/notify.js";

interface NotifierConfig {
  enabled: boolean;
  kinds: Record<InteractionKind, boolean>;
  sounds: Record<InteractionKind, string>;
  titles: Record<InteractionKind, string>;
}

const DEFAULT_CONFIG: NotifierConfig = {
  enabled: true,
  kinds: { ask: true },
  sounds: { ask: "Glass" },
  titles: {
    ask: "❓ Agent asks",
  },
};

const BODY_MAX = 80;

function osascriptNotify(
  title: string,
  body: string,
  sound: string,
): Promise<boolean> {
  const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  let script = `display notification "${esc(body)}" with title "${esc(title)}"`;
  if (sound) script += ` sound name "${esc(sound)}"`;
  return new Promise((resolve) => {
    execFile("osascript", ["-e", script], { timeout: 5000 }, (err) =>
      resolve(!err),
    );
  });
}

function truncate(s: string, max: number): string {
  const collapsed = s.replace(/\s+/g, " ").trim();
  if (collapsed.length <= max) return collapsed;
  return `${collapsed.slice(0, max - 1)}…`;
}

export default function (pi: ExtensionAPI) {
  const config: NotifierConfig = { ...DEFAULT_CONFIG };
  let unsubscribe: (() => void) | null = null;

  function handleEvent(event: InteractionEvent): void {
    if (!config.enabled) return;
    if (!config.kinds[event.kind]) return;
    const title = config.titles[event.kind];
    const sound = config.sounds[event.kind];
    const body = truncate(event.summary, BODY_MAX);
    // Fire-and-forget; we don't await osascript inside the listener.
    void osascriptNotify(title, body, sound);
  }

  pi.on("session_start", async () => {
    // Replace any prior subscription (covers session_shutdown races
    // in /new or /resume flows where a new session starts in the
    // same process).
    unsubscribe?.();
    unsubscribe = addInteractionListener(handleEvent);
  });

  pi.on("session_shutdown", async () => {
    unsubscribe?.();
    unsubscribe = null;
  });

  function describeConfig(): string {
    const flags = (Object.keys(config.kinds) as InteractionKind[])
      .map((k) => `${k}=${config.kinds[k] ? "on" : "off"}`)
      .join(" ");
    return `notif: ${config.enabled ? "ON" : "OFF"} (${flags})`;
  }

  pi.registerCommand("notif-config", {
    description: "Toggle interaction notifications. Usage: /notif-config [ask]",
    handler: async (args: string, ctx) => {
      const arg = args.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
      if (!arg) {
        config.enabled = !config.enabled;
        ctx.ui.notify(describeConfig(), "info");
        return;
      }
      if (arg in config.kinds) {
        const kind = arg as InteractionKind;
        config.kinds[kind] = !config.kinds[kind];
        ctx.ui.notify(
          `${kind}: ${config.kinds[kind] ? "on" : "off"}  (${describeConfig()})`,
          "info",
        );
        return;
      }
      ctx.ui.notify(`Unknown kind "${arg}". Use: /notif-config [ask]`, "error");
    },
  });
}
