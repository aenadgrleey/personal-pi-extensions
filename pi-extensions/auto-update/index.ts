/**
 * Auto-Update Extension — checks for pi updates on startup and updates in the background.
 *
 * - On session_start: checks if a newer version exists, then installs that exact version.
 * - Notifies the user when an update is installed (or if it fails).
 * - Skips in print mode and non-interactive sessions.
 * - Won't run concurrent updates (guarded by a flag).
 */

import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

type InstallMethod = "bun-binary" | "pnpm" | "yarn" | "bun" | "npm" | "unknown";

type ParsedVersion = {
  major: number;
  minor: number;
  patch: number;
  prerelease?: string;
};

type SelfUpdateCommand = {
  command: string;
  args: string[];
  display: string;
};

const PACKAGE_NAME = "@earendil-works/pi-coding-agent";
const LATEST_VERSION_URL = "https://pi.dev/api/latest-version";

function parseVersion(value: string): ParsedVersion | undefined {
  const match = value
    .trim()
    .match(/^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+.*)?$/);
  if (!match) {
    return undefined;
  }

  const [, major, minor, patch, prerelease] = match;
  if (!major || !minor || !patch) {
    return undefined;
  }

  return {
    major: Number.parseInt(major, 10),
    minor: Number.parseInt(minor, 10),
    patch: Number.parseInt(patch, 10),
    prerelease,
  };
}

function compareVersions(
  leftVersion: string,
  rightVersion: string,
): number | undefined {
  const left = parseVersion(leftVersion);
  const right = parseVersion(rightVersion);
  if (!left || !right) {
    return undefined;
  }

  if (left.major !== right.major) return left.major - right.major;
  if (left.minor !== right.minor) return left.minor - right.minor;
  if (left.patch !== right.patch) return left.patch - right.patch;
  if (left.prerelease === right.prerelease) return 0;
  if (!left.prerelease) return 1;
  if (!right.prerelease) return -1;
  return left.prerelease.localeCompare(right.prerelease);
}

export function isNewerVersion(
  candidateVersion: string,
  currentVersion: string,
): boolean {
  const comparison = compareVersions(candidateVersion, currentVersion);
  return comparison !== undefined ? comparison > 0 : false;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function detectInstallMethod(): InstallMethod {
  const isBunBinary =
    import.meta.url.includes("$bunfs") ||
    import.meta.url.includes("~BUN") ||
    import.meta.url.includes("%7EBUN");
  if (isBunBinary) {
    return "bun-binary";
  }

  const isBunRuntime = !!process.versions.bun;
  const resolvedPath = `${__dirname}\0${process.execPath || ""}`
    .toLowerCase()
    .replace(/\\/g, "/");
  if (resolvedPath.includes("/pnpm/") || resolvedPath.includes("/.pnpm/")) {
    return "pnpm";
  }
  if (resolvedPath.includes("/yarn/") || resolvedPath.includes("/.yarn/")) {
    return "yarn";
  }
  if (isBunRuntime || resolvedPath.includes("/install/global/node_modules/")) {
    return "bun";
  }
  if (
    resolvedPath.includes("/npm/") ||
    resolvedPath.includes("/node_modules/")
  ) {
    return "npm";
  }
  return "unknown";
}

export function buildSelfUpdateCommand(
  method: InstallMethod,
  version: string,
): SelfUpdateCommand | undefined {
  const spec = `${PACKAGE_NAME}@${version}`;
  switch (method) {
    case "bun-binary":
    case "unknown":
      return undefined;
    case "pnpm":
      return {
        command: "pnpm",
        args: ["install", "-g", spec],
        display: `pnpm install -g ${spec}`,
      };
    case "yarn":
      return {
        command: "yarn",
        args: ["global", "add", spec],
        display: `yarn global add ${spec}`,
      };
    case "bun":
      return {
        command: "bun",
        args: ["install", "-g", spec],
        display: `bun install -g ${spec}`,
      };
    case "npm":
      return {
        command: "npm",
        args: ["install", "-g", spec],
        display: `npm install -g ${spec}`,
      };
  }
}

async function getLatestVersion(): Promise<string | undefined> {
  try {
    const response = await fetch(LATEST_VERSION_URL, {
      headers: {
        "User-Agent": "pi-auto-update",
        accept: "application/json",
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      return undefined;
    }

    const data = (await response.json()) as { version?: unknown };
    return typeof data.version === "string" && data.version.trim()
      ? data.version.trim()
      : undefined;
  } catch {
    return undefined;
  }
}

export default function (pi: ExtensionAPI) {
  let updating = false;

  const extractVersion = (value: string) => {
    const match = value.trim().match(/\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/);
    return match?.[0] ?? value.trim();
  };

  const runUpdate = async (ctx: ExtensionContext) => {
    if (updating) return;
    updating = true;

    try {
      const currentResult = await pi.exec("pi", ["--version"], {
        timeout: 10_000,
      });
      const currentVersion = extractVersion(currentResult.stdout);
      const latestVersion = await getLatestVersion();

      if (!latestVersion) {
        ctx.ui.notify("Auto-update: could not check for updates", "error");
        return;
      }

      if (!isNewerVersion(latestVersion, currentVersion)) {
        return;
      }

      const updateCommand = buildSelfUpdateCommand(
        detectInstallMethod(),
        latestVersion,
      );
      if (!updateCommand) {
        ctx.ui.setStatus("auto-update", "✗ update unavailable");
        ctx.ui.notify(
          "Auto-update unavailable for this pi installation",
          "error",
        );
        return;
      }

      ctx.ui.setStatus(
        "auto-update",
        `⏳ updating pi ${currentVersion} → ${latestVersion}…`,
      );

      const updateResult = await pi.exec(
        updateCommand.command,
        updateCommand.args,
        { timeout: 120_000 },
      );

      if (updateResult.code === 0) {
        const verifiedResult = await pi.exec("pi", ["--version"], {
          timeout: 10_000,
        });
        const verifiedVersion = extractVersion(verifiedResult.stdout);
        if (verifiedVersion !== latestVersion) {
          ctx.ui.setStatus(
            "auto-update",
            `✗ update mismatch (${verifiedVersion})`,
          );
          ctx.ui.notify(
            `pi updated, but version check still reports ${verifiedVersion} instead of ${latestVersion}`,
            "error",
          );
          return;
        }

        ctx.ui.setStatus(
          "auto-update",
          `✓ pi updated to ${latestVersion} (restart to use)`,
        );
        ctx.ui.notify(
          `pi updated to ${latestVersion} — restart to use the new version`,
          "info",
        );
      } else {
        const output = (updateResult.stdout + updateResult.stderr)
          .trim()
          .slice(0, 200);
        ctx.ui.setStatus("auto-update", `✗ update failed`);
        ctx.ui.notify(`pi update failed: ${output}`, "error");
      }
    } catch (err) {
      ctx.ui.setStatus("auto-update", "✗ update error");
      ctx.ui.notify(
        `Auto-update error: ${err instanceof Error ? err.message : String(err)}`,
        "error",
      );
    } finally {
      updating = false;
    }
  };

  pi.on("session_start", (event, ctx) => {
    // Only run on initial startup, not on reload/new/resume/fork
    if (event.reason !== "startup") return;
    // Skip non-interactive modes
    if (!ctx.hasUI) return;

    void runUpdate(ctx);
  });
}
