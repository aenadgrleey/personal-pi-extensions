import assert from "node:assert/strict";

import {
  credentialDecision,
  isStructurallyValidOAuth,
  reconcileSnapshot,
  type OAuthCredential,
} from "./service.ts";

const now = 1_000;
const fresh: OAuthCredential = {
  type: "oauth",
  refresh: "refresh-a",
  access: "access-a",
  expires: now + 1_000,
  accountId: "account-a",
};
const elapsed: OAuthCredential = { ...fresh, expires: now - 1 };

assert.equal(isStructurallyValidOAuth(fresh), true);
assert.equal(isStructurallyValidOAuth({ type: "oauth", refresh: "x" }), false);
assert.equal(credentialDecision(undefined, undefined, now), "remove");
assert.equal(
  credentialDecision({ type: "oauth", refresh: "" }, undefined, now),
  "remove",
);
assert.equal(
  credentialDecision(fresh, { kind: "transient-failure" }, now),
  "keep",
);
assert.equal(
  credentialDecision(fresh, { kind: "unexpected-failure" }, now),
  "keep",
);
assert.equal(
  credentialDecision(elapsed, { kind: "transient-failure" }, now),
  "remove",
);
assert.equal(
  credentialDecision(fresh, { kind: "auth-rejected" }, now),
  "remove",
);
assert.equal(
  credentialDecision(elapsed, { kind: "auth-rejected" }, now),
  "remove",
);
assert.equal(
  credentialDecision(
    elapsed,
    { kind: "refreshed", oauth: { ...fresh, expires: now + 2_000 } },
    now,
  ),
  "replace",
);
assert.equal(
  credentialDecision(
    elapsed,
    { kind: "refreshed", oauth: { ...fresh, refresh: "other" } },
    now,
  ),
  "remove",
);
assert.equal(
  credentialDecision(
    fresh,
    { kind: "refreshed", oauth: { ...fresh, accountId: "other" } },
    now,
  ),
  "keep",
);

const snapshot = { id: "one", oauth: fresh, revision: "v1" };
const replacement = { ...fresh, access: "new", expires: now + 5_000 };
assert.deepEqual(
  reconcileSnapshot([snapshot], snapshot, "replace", replacement),
  [{ ...snapshot, oauth: replacement }],
);
assert.deepEqual(
  reconcileSnapshot([{ ...snapshot, revision: "v2" }], snapshot, "remove"),
  [{ ...snapshot, revision: "v2" }],
);
assert.deepEqual(reconcileSnapshot([snapshot], snapshot, "remove"), []);

console.log("codex-swap service tests passed");
