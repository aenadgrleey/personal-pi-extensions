export type HonchoStatus =
  "off" | "connected" | "syncing" | "offline" | "error";

export interface StatusContext {
  ui: {
    setStatus: (id: string, text: string) => void;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    theme: any;
  };
}

const isStaleCtxError = (err: unknown): boolean => {
  const message = err instanceof Error ? err.message : String(err);
  return message.includes("extension ctx is stale");
};

/**
 * Best-effort status update. After session replacement/reload, pi invalidates
 * captured ctx objects; touching ctx.ui then throws and would exit the process
 * if left uncaught (upstream @agney/pi-honcho-memory bug).
 */
export const setStatus = (ctx: StatusContext, state: HonchoStatus): void => {
  try {
    const { theme } = ctx.ui;
    const labels: Record<HonchoStatus, string> = {
      off: theme.fg("dim", "🧠 Honcho off"),
      connected: theme.fg("success", "🧠 Connected"),
      syncing: theme.fg("warning", "🧠 Syncing"),
      offline: theme.fg("dim", "🧠 Offline"),
      error: theme.fg("error", "🧠 Error"),
    };
    ctx.ui.setStatus("honcho", labels[state]);
  } catch (err) {
    if (!isStaleCtxError(err)) {
      throw err;
    }
  }
};
