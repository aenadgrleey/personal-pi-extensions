import { afterEach, describe, expect, test } from "bun:test";
import indicators from "./indicators.ts";

type Handler = (...args: any[]) => unknown;

type FakeFooterController = {
  render(width: number): string[];
  dispose(): void;
  invalidate(): void;
};

type FooterFactory = (
  tui: { requestRender(): void },
  theme: { fg(color: string, text: string): string },
  footerData: {
    onBranchChange(listener: () => void): () => void;
    getGitBranch(): string | null | undefined;
    getExtensionStatuses(): ReadonlyMap<string, string>;
  },
) => FakeFooterController;

type FakePi = {
  on(event: string, handler: Handler): void;
  getThinkingLevel(): string;
  events: {
    on(channel: string, handler: Handler): () => void;
    emit(channel: string, data: unknown): void;
  };
};

function makeUsageResponse(usedPercent: number): any {
  return {
    ok: true,
    json: async () => ({
      rate_limit: {
        primary_window: {
          used_percent: usedPercent,
          reset_at: 1_700_000_000,
          limit_window_seconds: 5 * 60 * 60,
        },
      },
    }),
  };
}

function createFakePi() {
  const handlers = new Map<string, Handler[]>();
  const eventHandlers = new Map<string, Handler[]>();

  const pi: FakePi = {
    on(event, handler) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    getThinkingLevel() {
      return "off";
    },
    events: {
      on(channel, handler) {
        const list = eventHandlers.get(channel) ?? [];
        list.push(handler);
        eventHandlers.set(channel, list);
        return () => {
          const next = (eventHandlers.get(channel) ?? []).filter(
            (current) => current !== handler,
          );
          if (next.length > 0) eventHandlers.set(channel, next);
          else eventHandlers.delete(channel);
        };
      },
      emit(channel, data) {
        for (const handler of eventHandlers.get(channel) ?? []) {
          void handler(data);
        }
      },
    },
  };

  return {
    pi,
    handlers,
  };
}

function makeContext() {
  let credential = {
    type: "oauth" as const,
    access: "token-1",
    accountId: "first",
  };

  const requestRenderCalls = { count: 0 };
  let footerController: FakeFooterController | undefined;

  const ctx = {
    hasUI: true,
    cwd: "/tmp/work",
    model: {
      provider: "openai-codex",
      id: "gpt-5.4",
    },
    sessionManager: {
      getBranch() {
        return [];
      },
    },
    getContextUsage() {
      return { tokens: 5, contextWindow: 100 };
    },
    modelRegistry: {
      authStorage: {
        get(provider: string) {
          return provider === "openai-codex" ? credential : undefined;
        },
        reload() {},
      },
    },
    ui: {
      setFooter(factory: FooterFactory) {
        footerController = factory(
          {
            requestRender() {
              requestRenderCalls.count += 1;
            },
          },
          {
            fg(_color: string, text: string) {
              return text;
            },
          },
          {
            onBranchChange(listener: () => void) {
              return () => {
                void listener;
              };
            },
            getGitBranch() {
              return null;
            },
            getExtensionStatuses() {
              return new Map();
            },
          },
        );
      },
    },
  };

  return {
    ctx,
    requestRenderCalls,
    getFooterController() {
      return footerController;
    },
    setCredential(nextCredential: typeof credential) {
      credential = nextCredential;
    },
  };
}

async function flush() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("indicators CodexSwap refresh", () => {
  test("refreshes the Codex account badge after codexswap account changes", async () => {
    const { pi, handlers } = createFakePi();
    indicators(pi as never);

    const { ctx, requestRenderCalls, getFooterController, setCredential } =
      makeContext();

    let resolveFirstFetch: ((value: any) => void) | undefined;
    let resolveSecondFetch: ((value: any) => void) | undefined;
    let fetchCalls = 0;

    globalThis.fetch = (async () =>
      new Promise((resolve) => {
        fetchCalls += 1;
        if (fetchCalls === 1) resolveFirstFetch = resolve;
        else resolveSecondFetch = resolve;
      })) as unknown as typeof fetch;

    const sessionStart = handlers.get("session_start")?.[0];
    expect(sessionStart).toBeDefined();

    const startupPromise = Promise.resolve(
      sessionStart?.({ reason: "startup" }, ctx as never),
    );

    expect(getFooterController()).toBeDefined();
    await flush();
    expect(fetchCalls).toBe(1);

    setCredential({
      type: "oauth",
      access: "token-2",
      accountId: "second",
    });

    pi.events.emit("codexswap:account-changed", undefined);
    expect(fetchCalls).toBe(1);

    resolveFirstFetch?.(makeUsageResponse(12));
    await flush();

    expect(fetchCalls).toBe(2);
    resolveSecondFetch?.(makeUsageResponse(34));
    await flush();
    await startupPromise;

    const footer = getFooterController();
    expect(footer).toBeDefined();
    const rendered = footer?.render(120)[0] ?? "";
    expect(rendered).toContain("acc:acc:second");
    expect(rendered).toContain("usage:5h:34%");
    expect(requestRenderCalls.count).toBeGreaterThanOrEqual(2);
  });
});
