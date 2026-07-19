import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const CURSOR_SDK_STACK_HINT =
  /(?:@cursor\/sdk|@connectrpc\/connect-node|pi-cursor-sdk)/;
const WRITE_ITERABLE_CLOSED_HINT =
  /(?:WriteIterableClosedError|WritableIterable is closed|cannot write, WritableIterable already closed)/i;

const CURSOR_PI_TOOL_BRIDGE_ENV = "PI_CURSOR_PI_TOOL_BRIDGE";
const CURSOR_EXPOSE_BUILTIN_TOOLS_ENV = "PI_CURSOR_EXPOSE_BUILTIN_TOOLS";

function extractErrorField(
  error: unknown,
  key: "name" | "message" | "stack",
): string {
  if (error instanceof Error) {
    return key === "stack" ? (error.stack ?? "") : (error[key] ?? "");
  }
  const record =
    typeof error === "object" && error !== null
      ? (error as Record<string, unknown>)
      : undefined;
  const value = record?.[key];
  return typeof value === "string" ? value : "";
}

export function isCursorSdkWriteIterableClosedError(error: unknown): boolean {
  const name = extractErrorField(error, "name");
  const message = extractErrorField(error, "message");
  const stack = extractErrorField(error, "stack");

  if (
    !WRITE_ITERABLE_CLOSED_HINT.test(name) &&
    !WRITE_ITERABLE_CLOSED_HINT.test(message)
  ) {
    return false;
  }

  return CURSOR_SDK_STACK_HINT.test(stack);
}

export function installCursorSdkWriteIterableClosedErrorGuard(): void {
  const globalState = globalThis as typeof globalThis & {
    __piCursorWriteIterableClosedGuardInstalled?: boolean;
  };

  if (globalState.__piCursorWriteIterableClosedGuardInstalled) return;
  globalState.__piCursorWriteIterableClosedGuardInstalled = true;

  const originalEmit = process.emit.bind(process);
  // Cursor can race a shutdown/reconnect against pending SDK writes and emit
  // WriteIterableClosedError from the SDK transport layer. Swallow only that
  // SDK-shaped case so unrelated process failures still surface normally.
  process.emit = ((event: string | symbol, ...args: unknown[]) => {
    if (
      (event === "uncaughtException" || event === "unhandledRejection") &&
      isCursorSdkWriteIterableClosedError(args[0])
    ) {
      return true;
    }

    return Reflect.apply(originalEmit, process, [event, ...args]) as boolean;
  }) as typeof process.emit;
}

export function configureCursorPiToolBridge(
  env: Record<string, string | undefined> = process.env,
): void {
  // pi-cursor-sdk intentionally hides Pi's overlapping built-ins by default.
  // That leaves a workflow-only session with no usable Pi tools over MCP. This
  // local integration wants Cursor agents to use the normal Pi tool pipeline,
  // so expose the complete active surface unless the user set either switch.
  if (env[CURSOR_PI_TOOL_BRIDGE_ENV] === undefined) {
    env[CURSOR_PI_TOOL_BRIDGE_ENV] = "1";
  }
  if (env[CURSOR_EXPOSE_BUILTIN_TOOLS_ENV] === undefined) {
    env[CURSOR_EXPOSE_BUILTIN_TOOLS_ENV] = "1";
  }
}

export default function (_pi: ExtensionAPI) {
  configureCursorPiToolBridge();
  installCursorSdkWriteIterableClosedErrorGuard();
}
