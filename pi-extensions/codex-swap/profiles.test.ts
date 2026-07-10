import assert from "node:assert/strict";

import {
  dedupeProfiles,
  normalizeEmail,
  redirectPreferenceSelector,
  type DedupeProfile,
} from "./profiles.ts";

const now = 1_000;
const profile = (
  id: string,
  email: string | undefined,
  accountId: string,
  refresh = `refresh-${id}`,
  savedAt = now,
): DedupeProfile => ({
  id,
  label: id,
  email,
  accountId,
  savedAt,
  oauth: {
    type: "oauth",
    refresh,
    expires: now + 1_000,
    access: `access-${id}`,
  },
});

assert.equal(normalizeEmail("  UsEr@Example.COM\u00a0"), "user@example.com");
assert.equal(
  normalizeEmail("person+one@example.com"),
  "person+one@example.com",
);
assert.notEqual(
  normalizeEmail("person@example.com"),
  normalizeEmail("person+one@example.com"),
);
assert.equal(
  dedupeProfiles(
    [
      profile("plain", "person@example.com", "plain"),
      profile("plus", "person+one@example.com", "plus"),
    ],
    { now },
  ).profiles.length,
  2,
);

const caseDuplicates = dedupeProfiles(
  [
    profile("older", " User@Example.com ", "old", "refresh-old", 1),
    profile("active", "user@example.COM", "new", "refresh-new", 2),
  ],
  { activeProfileId: "active", now },
);
assert.equal(caseDuplicates.profiles.length, 1);
assert.equal(caseDuplicates.profiles[0]?.id, "active");
assert.equal(caseDuplicates.redirects.get("old")?.id, "active");
assert.equal(caseDuplicates.activeProfileId, "active");
assert.equal(
  redirectPreferenceSelector("old", caseDuplicates.redirects),
  "new",
);
assert.equal(
  redirectPreferenceSelector("label:older", caseDuplicates.redirects),
  "new",
);

// Equivalent to `/codexswap add`: a newly logged-in casing variant merges.
const addSameEmail = dedupeProfiles(
  [
    profile("saved", "add@example.com", "saved-account"),
    profile("added", " ADD@example.com ", "new-account", "refresh-added", 2),
  ],
  { now },
);
assert.equal(addSameEmail.profiles.length, 1);

// A refresh can reveal an email which reconciles a formerly unknown profile.
const discoveredAfterRefresh = profile("refreshed", "refresh@example.com", "r");
const unknownBeforeRefresh = profile("unknown", undefined, "u", "refresh-u", 2);
unknownBeforeRefresh.email = " REFRESH@example.com ";
const refreshReconciled = dedupeProfiles(
  [discoveredAfterRefresh, unknownBeforeRefresh],
  { lastProfileId: "unknown", now },
);
assert.equal(refreshReconciled.profiles.length, 1);
assert.equal(refreshReconciled.lastProfileId, "unknown");

const liveWins = dedupeProfiles(
  [
    profile("active", "same@example.com", "one"),
    profile("live", "same@example.com", "two"),
  ],
  { activeProfileId: "active", liveRefresh: "refresh-live", now },
);
assert.equal(liveWins.profiles[0]?.id, "live");
assert.equal(liveWins.activeProfileId, "live");

const staleIds = dedupeProfiles(
  [
    profile("one", "same@example.com", "stale-one"),
    profile("two", "same@example.com", "stale-two", "refresh-two", 2),
  ],
  { now },
);
assert.equal(staleIds.profiles.length, 1);
assert.equal(staleIds.redirects.get("stale-two")?.id, "one");

assert.equal(
  dedupeProfiles(
    [
      profile("account-a", "old@example.com", "same-account"),
      profile("account-b", "new@example.com", "same-account", "refresh-b"),
    ],
    { now },
  ).profiles.length,
  1,
);

const concurrent = dedupeProfiles(
  [
    profile("writer-a", "same@example.com", "a", "refresh-a", 1),
    profile("writer-b", " SAME@example.com", "b", "refresh-b", 3),
  ],
  { now },
);
assert.equal(concurrent.profiles.length, 1);
assert.equal(concurrent.profiles[0]?.id, "writer-b");

const malformed = profile("malformed", "bad@example.com", "bad");
delete malformed.oauth.expires;
assert.equal(dedupeProfiles([malformed], { now }).profiles.length, 0);

// Output stays metadata-only; credentials are never part of diagnostic values.
assert.doesNotMatch(
  JSON.stringify({
    ids: concurrent.profiles.map((entry) => entry.id),
    redirects: [...concurrent.redirects.keys()],
  }),
  /access-|refresh-/,
);

console.log("codex-swap profile dedupe tests passed");
