#!/usr/bin/env tsx
/**
 * Generate CHANGELOG.md from git history.
 *
 * The repository operating model derives the changelog exclusively from
 * conventional commit messages; CHANGELOG.md is a generated artifact and
 * must never be edited by hand. Run `pnpm changelog:generate` to rewrite
 * it, and `pnpm changelog:check` (or `--check`) in CI to fail when the
 * committed file drifts from what git history produces.
 *
 * Grouping: repositories with semantic-version tags (execution-system:
 * 0.1.0, 0.1.1, ...) get one section per tag plus an Unreleased section
 * for commits after the newest tag. Repositories without tags render a
 * single Unreleased section over the whole history.
 *
 * Commit classification follows the conventional-commit prefix:
 * feat -> Features, fix -> Bug Fixes, perf -> Performance,
 * docs -> Documentation, refactor/chore/test/ci/build/style -> Maintenance.
 * Merge commits are excluded (git log --no-merges).
 */
import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const repository = path.resolve(import.meta.dirname, "..");
const checkOnly = process.argv.includes("--check");
const outputFile = process.argv.slice(2).filter((arg) => arg !== "--check")[0] ?? path.join(repository, "CHANGELOG.md");

function gitLog(range: string): string[] {
  const args = ["log", "--no-merges", "--format=%s", ...(range === "" ? [] : [range])];
  const out = execFileSync("git", args, { cwd: repository, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
  return out.split("\n").map((line) => line.trim()).filter((line) => line.length > 0);
}

function gitTags(): string[] {
  try {
    const out = execFileSync("git", ["tag"], { cwd: repository, encoding: "utf8" });
    return out.split("\n").map((line) => line.trim()).filter((line) => line.length > 0)
      .sort((left, right) => compareSemver(right, left));
  } catch {
    return [];
  }
}

/** Semantic-version comparison: 0.1.1 > 0.1.1-rc.1 > 0.1.0 > 0.1.0-rc.1. */
function compareSemver(left: string, right: string): number {
  const parse = (value: string): [number, number, number, string] => {
    const [core, prerelease = ""] = value.split("-");
    const [major, minor, patch] = core.split(".").map((part) => Number.parseInt(part, 10) || 0);
    return [major, minor, patch, prerelease];
  };
  const [lmaj, lmin, lpat, lpre] = parse(left);
  const [rmaj, rmin, rpat, rpre] = parse(right);
  if (lmaj !== rmaj) return lmaj - rmaj;
  if (lmin !== rmin) return lmin - rmin;
  if (lpat !== rpat) return lpat - rpat;
  if (lpre === rpre) return 0;
  if (lpre === "") return 1;   // release > prerelease
  if (rpre === "") return -1;
  return lpre < rpre ? -1 : 1;
}

interface Commit {
  readonly message: string;
  readonly type: string;
  readonly scope: string;
  readonly subject: string;
}

function parseCommit(message: string): Commit {
  const match = /^([a-zA-Z]+)(?:\(([^)]+)\))?!?:\s*(.*)$/u.exec(message);
  if (match === null) return { message, type: "other", scope: "", subject: message };
  return { message, type: match[1]!.toLowerCase(), scope: match[2] ?? "", subject: match[3] ?? "" };
}

const CATEGORIES: ReadonlyArray<{ readonly key: string; readonly heading: string; readonly types: ReadonlySet<string> }> = [
  { key: "features", heading: "### Features", types: new Set(["feat"]) },
  { key: "fixes", heading: "### Bug Fixes", types: new Set(["fix"]) },
  { key: "performance", heading: "### Performance", types: new Set(["perf"]) },
  { key: "docs", heading: "### Documentation", types: new Set(["docs"]) },
  { key: "maintenance", heading: "### Maintenance", types: new Set(["refactor", "chore", "test", "ci", "build", "style"]) },
];

function categorized(commits: readonly Commit[]): string {
  const sections = CATEGORIES
    .map((category) => {
      const items = commits.filter((commit) => category.types.has(commit.type));
      if (items.length === 0) return "";
      const bullets = items.map((commit) => {
        const scope = commit.scope.length > 0 ? `**${commit.scope}** ` : "";
        return `- ${scope}${commit.subject}`;
      });
      return `${category.heading}\n\n${bullets.join("\n")}\n`;
    })
    .filter((section) => section.length > 0);

  const other = commits.filter((commit) => !CATEGORIES.some((category) => category.types.has(commit.type)));
  if (other.length > 0) {
    sections.push(`### Other\n\n${other.map((commit) => `- ${commit.subject}`).join("\n")}\n`);
  }
  return sections.join("\n");
}

function sectionTitle(name: string, commits: readonly Commit[]): string {
  const date = execFileSync("git", ["log", "-1", "--format=%ad", "--date=short", ...(name === "Unreleased" ? [] : [name])], {
    cwd: repository, encoding: "utf8",
  }).trim();
  return `## [${name}]${date.length > 0 ? ` - ${date}` : ""}\n\n${commits.length} commits`;
}

function render(tags: readonly string[]): string {
  // Drop tags that point at the same commit as the newer tag (the promote
  // pipeline tags the stable release on the RC commit), so the stable
  // section absorbs the RC commits instead of rendering an empty section.
  const rev = (ref: string): string => execFileSync("git", ["rev-parse", `${ref}^{commit}`], { cwd: repository, encoding: "utf8" }).trim();
  const distinct = tags.filter((tag, index) => index === 0 || rev(tag) !== rev(tags[index - 1]!));

  const ranges: Array<{ readonly name: string; readonly range: string }> = [];
  if (distinct.length === 0) {
    ranges.push({ name: "Unreleased", range: "" });
  } else {
    // `git log A` walks A's ancestors; "after the newest tag" must be explicit A..HEAD.
    ranges.push({ name: "Unreleased", range: `${distinct[0]}..HEAD` });
    for (let index = 0; index < distinct.length; index += 1) {
      ranges.push({ name: distinct[index]!, range: index + 1 < distinct.length ? `${distinct[index + 1]!}..${distinct[index]!}` : distinct[index]! });
    }
  }

  const sections = ranges
    .map(({ name, range }) => {
      const commits = gitLog(range).map(parseCommit);
      if (commits.length === 0) return "";
      return `${sectionTitle(name, commits)}\n\n${categorized(commits)}\n`;
    })
    .filter((section) => section.length > 0);

  return [
    "# Changelog",
    "",
    "All notable changes are derived from conventional commit messages in git history.",
    "This file is generated by `pnpm changelog:generate` and must not be edited by hand.",
    "",
    ...sections,
  ].join("\n");
}

const generated = render(gitTags());

if (checkOnly) {
  let existing = "";
  try { existing = await readFile(outputFile, "utf8"); } catch { /* missing file fails the check */ }
  if (existing.trim() !== generated.trim()) {
    console.error(`CHANGELOG drift: ${outputFile} does not match git history. Run 'pnpm changelog:generate' and commit the result.`);
    process.exit(1);
  }
  console.log("CHANGELOG matches git history.");
} else {
  await writeFile(outputFile, `${generated.trim()}\n`);
  console.log(`Generated ${outputFile}`);
}
