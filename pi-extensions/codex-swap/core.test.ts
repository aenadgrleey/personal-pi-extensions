import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  clearRepositoryPreference,
  discoverRepositoryRoot,
  readRepositoryPreference,
  repositoryPreferencePath,
  resolvePreferredProfile,
  writeRepositoryPreference,
} from "./core.ts";

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "codex-swap-core-"));
const makeDirectory = (name: string) => {
  const directory = path.join(temp, name);
  fs.mkdirSync(directory, { recursive: true });
  return directory;
};

try {
  const normal = makeDirectory("normal/nested/deeper");
  fs.mkdirSync(path.join(temp, "normal", ".git"));
  assert.equal(
    discoverRepositoryRoot(normal),
    fs.realpathSync(path.join(temp, "normal")),
  );

  const worktree = makeDirectory("worktree/subdir");
  const gitdir = makeDirectory("metadata/worktree");
  fs.writeFileSync(path.join(temp, "worktree", ".git"), `gitdir: ${gitdir}\n`);
  assert.equal(
    discoverRepositoryRoot(worktree),
    fs.realpathSync(path.join(temp, "worktree")),
  );

  const malformed = makeDirectory("malformed");
  fs.writeFileSync(path.join(malformed, ".git"), "gitdir: ./missing\nextra");
  assert.equal(discoverRepositoryRoot(malformed), undefined);
  const symlinked = makeDirectory("symlinked");
  fs.symlinkSync(gitdir, path.join(symlinked, ".git"));
  assert.equal(discoverRepositoryRoot(symlinked), undefined);

  const root = path.join(temp, "normal");
  const preference = writeRepositoryPreference(root, "account-123");
  assert.equal(preference, repositoryPreferencePath(root));
  assert.equal(fs.readFileSync(preference, "utf8"), "account-123\n");
  assert.deepEqual(readRepositoryPreference(root), {
    state: "valid",
    path: preference,
    accountId: "account-123",
  });
  fs.writeFileSync(preference, "account-123\nextra\n");
  assert.equal(readRepositoryPreference(root).state, "invalid");
  fs.writeFileSync(preference, "\u0000\n");
  assert.equal(readRepositoryPreference(root).state, "invalid");
  fs.writeFileSync(preference, "x".repeat(300));
  assert.equal(readRepositoryPreference(root).state, "invalid");
  fs.unlinkSync(preference);
  fs.symlinkSync("/tmp", preference);
  assert.equal(readRepositoryPreference(root).state, "invalid");
  assert.throws(() => clearRepositoryPreference(root), /Unsafe/);
  fs.unlinkSync(preference);
  writeRepositoryPreference(root, "account-456");
  assert.equal(clearRepositoryPreference(root), preference);
  assert.equal(readRepositoryPreference(root).state, "absent");

  const profiles = [
    { id: "one", accountId: "account-1" },
    { id: "two", accountId: "account-2" },
  ];
  assert.deepEqual(
    resolvePreferredProfile(
      { state: "valid", path: preference, accountId: "account-2" },
      "account-1",
      profiles,
    ),
    { kind: "selected", scope: "repository", profile: profiles[1] },
  );
  assert.deepEqual(
    resolvePreferredProfile({ state: "absent" }, "account-1", profiles),
    { kind: "selected", scope: "global", profile: profiles[0] },
  );
  assert.deepEqual(
    resolvePreferredProfile(
      { state: "invalid", path: preference },
      "account-1",
      profiles,
    ),
    { kind: "blocked", scope: "repository" },
  );
  assert.deepEqual(
    resolvePreferredProfile(
      { state: "valid", path: preference, accountId: "missing" },
      "account-1",
      profiles,
    ),
    { kind: "blocked", scope: "repository" },
  );
  assert.deepEqual(
    resolvePreferredProfile(
      { state: "valid", path: preference, accountId: "account-1" },
      undefined,
      [...profiles, { id: "duplicate", accountId: "account-1" }],
    ),
    { kind: "blocked", scope: "repository" },
  );

  console.log("codex-swap core tests passed");
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
