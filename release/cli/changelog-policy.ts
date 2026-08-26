const CHANGELOG_META_PATH = "CHANGELOG.md";
const RELEASE_CANDIDATE_PREFIX = "release/candidates/";

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
