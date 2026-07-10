export type OAuthCredential = {
  type: "oauth";
  refresh?: string;
  access?: string;
  key?: string;
  expires?: number;
  accountId?: string;
  [key: string]: unknown;
};

export type RefreshOutcome =
  | { kind: "refreshed"; oauth: OAuthCredential }
  | { kind: "auth-rejected" }
  | { kind: "transient-failure" }
  | { kind: "unexpected-failure" };

export type CredentialDecision = "keep" | "replace" | "remove";

export function isStructurallyValidOAuth(
  oauth: OAuthCredential | undefined,
): oauth is OAuthCredential & { refresh: string; expires: number } {
  return Boolean(
    oauth?.type === "oauth" &&
    typeof oauth.refresh === "string" &&
    oauth.refresh.length > 0 &&
    typeof oauth.expires === "number" &&
    Number.isFinite(oauth.expires),
  );
}

export function credentialDecision(
  oauth: OAuthCredential | undefined,
  outcome: RefreshOutcome | undefined,
  now: number,
): CredentialDecision {
  if (!isStructurallyValidOAuth(oauth)) return "remove";
  if (!outcome) return "keep";
  if (outcome.kind === "auth-rejected") return "remove";
  if (outcome.kind === "refreshed") {
    return isStructurallyValidOAuth(outcome.oauth) &&
      (outcome.oauth.access || outcome.oauth.key) &&
      outcome.oauth.expires! > now &&
      outcome.oauth.refresh === oauth.refresh &&
      (!oauth.accountId || outcome.oauth.accountId === oauth.accountId)
      ? "replace"
      : now >= oauth.expires!
        ? "remove"
        : "keep";
  }
  // A network/unknown error only proves expiry for a credential that was
  // already elapsed. An otherwise usable live credential is kept byte-for-byte.
  return now >= oauth.expires! ? "remove" : "keep";
}

export type VersionedProfile<T extends OAuthCredential = OAuthCredential> = {
  id: string;
  oauth: T;
  revision: string;
};

/**
 * Conditional reconciliation used after remote work. Callers capture a profile
 * under their short store lock, release it for refresh/usage/UI, then invoke
 * this against a newly locked store. A changed snapshot is never overwritten.
 */
export function reconcileSnapshot<T extends OAuthCredential>(
  profiles: VersionedProfile<T>[],
  snapshot: VersionedProfile<T>,
  decision: CredentialDecision,
  replacement?: T,
): VersionedProfile<T>[] {
  const current = profiles.find((profile) => profile.id === snapshot.id);
  if (!current || current.revision !== snapshot.revision) return profiles;
  if (decision === "remove")
    return profiles.filter((profile) => profile.id !== snapshot.id);
  if (decision === "replace" && replacement) {
    return profiles.map((profile) =>
      profile.id === snapshot.id
        ? { ...profile, oauth: replacement, revision: profile.revision }
        : profile,
    );
  }
  return profiles;
}
