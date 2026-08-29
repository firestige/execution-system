const CHANGELOG_META_PATH = "CHANGELOG.md";
const RELEASE_CANDIDATE_PREFIX = "release/candidates/";
const SEMVER_RELEASE_TAG = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;

/** Changelog ranges are bounded only by versioned releases, not operational tags. */
export function isChangelogReleaseTag(tag: string): boolean {
  return SEMVER_RELEASE_TAG.test(tag);
}

/**
 * Identifies commits that only persist generated release evidence.
 *
 * These commits bind already-built bytes to git history; including them in
 * release notes would make candidate archival recursively change the bytes
 * whose identity it records.
 */
export function isChangelogMetaCommit(files: readonly string[]): boolean {
  return files.length > 0 && files.every((file) => (
    file === CHANGELOG_META_PATH || file.startsWith(RELEASE_CANDIDATE_PREFIX)
  ));
}
