import fs from "node:fs";
import path from "node:path";

/** The sole repository-local Codex-swap setting. It deliberately contains no OAuth data. */
export const REPOSITORY_PREFERENCE_RELATIVE_PATH = path.join(
  ".pi",
  "codex-swap",
  "preferred-account-id",
);

const MAX_SELECTOR_BYTES = 256;
const MAX_GITFILE_BYTES = 4096;

export type PreferenceRead =
  | { state: "absent"; path?: string }
  | { state: "valid"; path: string; accountId: string }
  | { state: "invalid"; path?: string };

export type StoredProfile = {
  id: string;
  accountId?: string;
};

function lstatOrUndefined(file: string): fs.Stats | undefined {
  try {
    return fs.lstatSync(file);
  } catch {
    return undefined;
  }
}

function isSafeDirectory(directory: string): boolean {
  const stat = lstatOrUndefined(directory);
  return Boolean(stat?.isDirectory() && !stat.isSymbolicLink());
}

function readBoundedRegularUtf8(file: string, maxBytes: number): string | null {
  const stat = lstatOrUndefined(file);
  if (!stat?.isFile() || stat.isSymbolicLink() || stat.size > maxBytes) {
    return null;
  }

  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(file, fs.constants.O_RDONLY);
    const opened = fs.fstatSync(descriptor);
    if (!opened.isFile() || opened.size > maxBytes) return null;
    const buffer = Buffer.alloc(opened.size);
    fs.readSync(descriptor, buffer, 0, buffer.length, 0);
    const text = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
    return text;
  } catch {
    return null;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function realDirectory(directory: string): string | undefined {
  if (!isSafeDirectory(directory)) return undefined;
  try {
    const resolved = fs.realpathSync(directory);
    return isSafeDirectory(resolved) ? resolved : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Locate a worktree without invoking git. A .git gitfile is accepted only when
 * its complete bounded payload is a single `gitdir: <directory>` record.
 */
export function discoverRepositoryRoot(cwd: string): string | undefined {
  let current: string;
  try {
    current = fs.realpathSync(path.resolve(cwd));
  } catch {
    return undefined;
  }
  if (!isSafeDirectory(current)) return undefined;

  for (;;) {
    const gitEntry = path.join(current, ".git");
    const stat = lstatOrUndefined(gitEntry);
    if (stat && !stat.isSymbolicLink()) {
      if (stat.isDirectory()) return current;
      if (stat.isFile()) {
        const gitfile = readBoundedRegularUtf8(gitEntry, MAX_GITFILE_BYTES);
        const match = gitfile?.match(/^gitdir: ([^\r\n]+)\r?\n?$/);
        if (match) {
          const configured = match[1];
          const gitdir = path.isAbsolute(configured)
            ? configured
            : path.resolve(current, configured);
          if (realDirectory(gitdir)) return current;
        }
      }
    }
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

export function repositoryPreferencePath(root: string): string {
  return path.join(root, REPOSITORY_PREFERENCE_RELATIVE_PATH);
}

function isAccountId(value: string): boolean {
  return (
    value.length > 0 &&
    Buffer.byteLength(value, "utf8") <= MAX_SELECTOR_BYTES &&
    /^[\x21-\x7e]+$/.test(value)
  );
}

/** Read a selector without following a symlink at any preference-specific path. */
export function readRepositoryPreference(root: string): PreferenceRead {
  const base = path.join(root, ".pi");
  const directory = path.join(base, "codex-swap");
  const file = repositoryPreferencePath(root);
  const fileStat = lstatOrUndefined(file);
  if (!fileStat) return { state: "absent", path: file };
  if (
    !isSafeDirectory(root) ||
    !isSafeDirectory(base) ||
    !isSafeDirectory(directory) ||
    !fileStat.isFile() ||
    fileStat.isSymbolicLink()
  ) {
    return { state: "invalid", path: file };
  }
  const payload = readBoundedRegularUtf8(file, MAX_SELECTOR_BYTES + 1);
  if (payload === null) return { state: "invalid", path: file };
  const accountId = payload.endsWith("\n") ? payload.slice(0, -1) : payload;
  if (!isAccountId(accountId) || payload !== `${accountId}\n`) {
    return { state: "invalid", path: file };
  }
  return { state: "valid", path: file, accountId };
}

function validatePreferenceParents(
  root: string,
  create: boolean,
): string | null {
  if (!isSafeDirectory(root)) return null;
  const piDirectory = path.join(root, ".pi");
  const preferenceDirectory = path.join(piDirectory, "codex-swap");
  if (create) {
    try {
      if (!fs.existsSync(piDirectory))
        fs.mkdirSync(piDirectory, { mode: 0o700 });
      if (!fs.existsSync(preferenceDirectory)) {
        fs.mkdirSync(preferenceDirectory, { mode: 0o700 });
      }
    } catch {
      return null;
    }
  }
  return isSafeDirectory(piDirectory) && isSafeDirectory(preferenceDirectory)
    ? preferenceDirectory
    : null;
}

/** Atomically write exactly accountId plus LF. Never follows a preference symlink. */
export function writeRepositoryPreference(
  root: string,
  accountId: string,
): string {
  if (!isAccountId(accountId))
    throw new Error("Invalid Codex account selector");
  const directory = validatePreferenceParents(root, true);
  if (!directory) throw new Error("Unsafe repository preference directory");
  const file = repositoryPreferencePath(root);
  const existing = lstatOrUndefined(file);
  if (existing && (!existing.isFile() || existing.isSymbolicLink())) {
    throw new Error("Unsafe repository preference target");
  }
  const temporary = path.join(
    directory,
    `.preferred-account-id.${process.pid}.${Math.random().toString(36).slice(2)}`,
  );
  try {
    fs.writeFileSync(temporary, `${accountId}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    if (!validatePreferenceParents(root, false)) {
      throw new Error("Unsafe repository preference directory");
    }
    const beforeRename = lstatOrUndefined(file);
    if (
      beforeRename &&
      (!beforeRename.isFile() || beforeRename.isSymbolicLink())
    ) {
      throw new Error("Unsafe repository preference target");
    }
    fs.renameSync(temporary, file);
    return file;
  } finally {
    try {
      fs.unlinkSync(temporary);
    } catch {
      // The rename succeeded or cleanup is unnecessary.
    }
  }
}

/** Clear only a safe regular selector file; an unsafe target is intentionally retained. */
export function clearRepositoryPreference(root: string): string {
  const file = repositoryPreferencePath(root);
  const existing = lstatOrUndefined(file);
  if (!existing) return file;
  if (!existing.isFile() || existing.isSymbolicLink()) {
    throw new Error("Unsafe repository preference target");
  }
  const directory = validatePreferenceParents(root, false);
  if (!directory) throw new Error("Unsafe repository preference directory");
  fs.unlinkSync(file);
  return file;
}

export type PreferenceResolution =
  | { kind: "none" }
  | { kind: "selected"; scope: "repository" | "global"; profile: StoredProfile }
  | { kind: "blocked"; scope: "repository" | "global" };

function uniqueAccountProfile(
  profiles: StoredProfile[],
  accountId: string,
): StoredProfile | undefined {
  const matches = profiles.filter((profile) => profile.accountId === accountId);
  return matches.length === 1 ? matches[0] : undefined;
}

/**
 * Repository input is a trust boundary: every present-but-bad repository
 * selector blocks global fallback. Global fallback happens only on absence.
 */
export function resolvePreferredProfile(
  repository: PreferenceRead,
  globalAccountId: string | undefined,
  profiles: StoredProfile[],
): PreferenceResolution {
  if (repository.state === "valid") {
    const profile = uniqueAccountProfile(profiles, repository.accountId);
    return profile
      ? { kind: "selected", scope: "repository", profile }
      : { kind: "blocked", scope: "repository" };
  }
  if (repository.state === "invalid")
    return { kind: "blocked", scope: "repository" };
  if (!globalAccountId) return { kind: "none" };
  const profile = uniqueAccountProfile(profiles, globalAccountId);
  return profile
    ? { kind: "selected", scope: "global", profile }
    : { kind: "blocked", scope: "global" };
}
