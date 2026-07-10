export type OAuthProfileCredential = {
  type: "oauth";
  refresh?: string;
  expires?: number;
  [key: string]: unknown;
};

export type DedupeProfile<
  T extends OAuthProfileCredential = OAuthProfileCredential,
> = {
  id: string;
  label: string;
  savedAt: number;
  lastUsedAt?: number;
  email?: string;
  accountId?: string;
  oauth: T;
};

export type DedupeOptions = {
  activeProfileId?: string;
  lastProfileId?: string;
  liveRefresh?: string;
  now?: number;
};

export type DedupeResult<T extends OAuthProfileCredential> = {
  profiles: DedupeProfile<T>[];
  /** Removed IDs and stale account IDs map to their retained canonical profile. */
  redirects: Map<string, DedupeProfile<T>>;
  activeProfileId?: string;
  lastProfileId?: string;
};

/** Exact, conservative account key: whitespace-insensitive casing only. */
export function normalizeEmail(email: string | undefined): string | undefined {
  if (typeof email !== "string") return undefined;
  const normalized = email.trim().toLocaleLowerCase();
  return normalized || undefined;
}

function credentialIsRefreshable(oauth: OAuthProfileCredential): boolean {
  return Boolean(
    oauth.type === "oauth" &&
    typeof oauth.refresh === "string" &&
    oauth.refresh.length > 0 &&
    typeof oauth.expires === "number" &&
    Number.isFinite(oauth.expires),
  );
}

function compareCandidates<T extends OAuthProfileCredential>(
  left: DedupeProfile<T>,
  right: DedupeProfile<T>,
  options: DedupeOptions,
): number {
  const rank = (
    profile: DedupeProfile<T>,
  ): readonly [number, number, number, number, number] => [
    profile.oauth.refresh === options.liveRefresh ? 1 : 0,
    profile.id === options.activeProfileId ? 1 : 0,
    credentialIsRefreshable(profile.oauth) ? 1 : 0,
    profile.id === options.lastProfileId ? 1 : 0,
    Math.max(profile.lastUsedAt ?? 0, profile.savedAt ?? 0),
  ];
  const leftRank = rank(left);
  const rightRank = rank(right);
  for (let index = 0; index < leftRank.length; index += 1) {
    if (leftRank[index]! !== rightRank[index]!)
      return leftRank[index]! - rightRank[index]!;
  }
  // Stable final tie-breaker. Never combine credentials from candidates.
  return right.id.localeCompare(left.id);
}

/**
 * Retain one complete credential per refresh token and per exact normalized
 * email. Account IDs help selection but cannot override an email collision:
 * stale IDs are routinely changed by upstream auth migrations.
 */
export function dedupeProfiles<T extends OAuthProfileCredential>(
  candidates: DedupeProfile<T>[],
  options: DedupeOptions = {},
): DedupeResult<T> {
  const redirects = new Map<string, DedupeProfile<T>>();
  const retained: DedupeProfile<T>[] = [];

  for (const source of candidates) {
    if (
      source.oauth?.type !== "oauth" ||
      typeof source.oauth.refresh !== "string" ||
      !source.oauth.refresh ||
      typeof source.oauth.expires !== "number" ||
      !Number.isFinite(source.oauth.expires)
    ) {
      continue;
    }
    const profile: DedupeProfile<T> = {
      ...source,
      label: source.label.trim() || "profile",
      email: normalizeEmail(source.email),
    };
    const same = retained.filter(
      (entry) =>
        entry.oauth.refresh === profile.oauth.refresh ||
        (entry.accountId !== undefined &&
          entry.accountId === profile.accountId) ||
        (entry.email !== undefined && entry.email === profile.email),
    );
    if (same.length === 0) {
      retained.push(profile);
      continue;
    }

    const group = [...same, profile];
    const winner = group.reduce((best, entry) =>
      compareCandidates(entry, best, options) > 0 ? entry : best,
    );
    for (const duplicate of group) {
      if (duplicate === winner) continue;
      const index = retained.indexOf(duplicate);
      if (index >= 0) retained.splice(index, 1);
      redirects.set(duplicate.id, winner);
      if (duplicate.accountId) redirects.set(duplicate.accountId, winner);
      redirects.set(
        `label:${duplicate.label.trim().toLocaleLowerCase()}`,
        winner,
      );
    }
    if (!retained.includes(winner)) retained.push(winner);
  }

  // Transitive collisions (A shares refresh with B, B shares email with C)
  // can surface as input ordering changes. Repeat until fixed point.
  if (
    retained.some((profile, index) =>
      retained
        .slice(index + 1)
        .some(
          (other) =>
            other.oauth.refresh === profile.oauth.refresh ||
            (other.accountId !== undefined &&
              other.accountId === profile.accountId) ||
            (profile.email !== undefined && profile.email === other.email),
        ),
    )
  ) {
    const next = dedupeProfiles(retained, options);
    for (const [key, profile] of next.redirects) redirects.set(key, profile);
    for (const [key, profile] of redirects) {
      const final = next.redirects.get(profile.id);
      if (final) redirects.set(key, final);
    }
    return { ...next, redirects };
  }

  const active = options.activeProfileId
    ? (redirects.get(options.activeProfileId)?.id ?? options.activeProfileId)
    : undefined;
  const previous = options.lastProfileId
    ? (redirects.get(options.lastProfileId)?.id ?? options.lastProfileId)
    : undefined;
  const retainedIds = new Set(retained.map((profile) => profile.id));
  return {
    profiles: retained,
    redirects,
    activeProfileId: retainedIds.has(active ?? "") ? active : retained[0]?.id,
    lastProfileId:
      previous && previous !== active && retainedIds.has(previous)
        ? previous
        : undefined,
  };
}

/** Redirect a stale account/profile selector only when its winner is known. */
export function redirectPreferenceSelector<T extends OAuthProfileCredential>(
  selector: string | undefined,
  redirects: ReadonlyMap<string, DedupeProfile<T>>,
): string | undefined {
  return selector ? redirects.get(selector)?.accountId : undefined;
}
