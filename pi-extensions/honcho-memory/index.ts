import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { bootstrap, clearHandles, getHandles } from "./client.js";
import { registerCommands } from "./commands.js";
import { resolveConfig } from "./config.js";
import {
  clearCachedMemory,
  flushPending,
  getCachedMemory,
  refreshMemoryCache,
  saveMessages,
} from "./memory.js";
import { setStatus, type StatusContext } from "./status.js";
import { registerTools } from "./tools.js";

export default function honcho(pi: ExtensionAPI): void {
  let initializing: Promise<void> | null = null;
  /** Bumped on every session_start so async work can drop stale ctx. */
  let sessionGeneration = 0;

  registerTools(pi);
  registerCommands(pi);

  const backgroundInit = (ctx: StatusContext & { cwd: string }): void => {
    const generation = sessionGeneration;
    initializing = (async () => {
      try {
        const config = await resolveConfig();
        if (generation !== sessionGeneration) {
          return;
        }
        if (!config.enabled || !config.apiKey) {
          setStatus(ctx, "off");
          return;
        }

        const handles = await bootstrap(pi, config, ctx.cwd);
        if (generation !== sessionGeneration) {
          return;
        }
        setStatus(ctx, "connected");
        await refreshMemoryCache(handles);
      } catch {
        if (generation === sessionGeneration) {
          setStatus(ctx, "offline");
        }
      } finally {
        if (generation === sessionGeneration) {
          initializing = null;
        }
      }
    })();
  };

  // Current pi emits session_start for startup/reload/new/resume/fork.
  // Upstream still listened for removed session_switch / session_fork events.
  pi.on("session_start", (_event, ctx) => {
    sessionGeneration += 1;
    clearHandles();
    clearCachedMemory();
    backgroundInit(ctx);
  });

  pi.on("before_agent_start", async (event) => {
    if (initializing) {
      await initializing;
    }

    const memoryText = getCachedMemory();
    if (!memoryText) {
      return;
    }

    return {
      systemPrompt: `${event.systemPrompt}\n\n${memoryText}`,
    };
  });

  pi.on("agent_end", async (event, ctx) => {
    const handles = getHandles();
    if (!handles || !handles.config.exportConversation) {
      return;
    }

    const generation = sessionGeneration;
    setStatus(ctx, "syncing");

    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-type-assertion
    saveMessages(handles, event.messages as any[])
      .then(() => {
        if (generation === sessionGeneration) {
          setStatus(ctx, "connected");
        }
      })
      .catch(() => {
        if (generation === sessionGeneration) {
          setStatus(ctx, "offline");
        }
      });
  });

  pi.on("session_before_compact", async () => {
    await flushPending();
  });

  pi.on("session_before_switch", async () => {
    await flushPending();
  });

  pi.on("session_before_fork", async () => {
    await flushPending();
  });

  pi.on("session_shutdown", async () => {
    await flushPending();
  });
}
