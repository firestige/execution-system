import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REQUIRED = ["What's new", "Compatibility", "Upgrade guide"] as const;

type Compatibility = Readonly<Record<"node" | "dsh" | "workflowContract" | "observationContract", string>>;

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function currentChangelogSection(version: string, changelog: string): string {
  const headings = [...changelog.matchAll(/^## \[([^\]\n]+)\][^\n]*\n/gmu)];
  const unreleasedIndex = headings.findIndex((heading) => heading[1] === "Unreleased");
  let selectedIndex = unreleasedIndex;
  let emptyCode = "CHANGELOG_UNRELEASED_SECTION_EMPTY";
  if (selectedIndex === -1) {
    const escapedVersion = version.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    const currentPrerelease = new RegExp(`^${escapedVersion}-[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*$`, "u");
    if (headings[0]?.[1] === undefined || !currentPrerelease.test(headings[0][1])) {
      throw new Error("CHANGELOG_CURRENT_PRERELEASE_SECTION_MISSING");
    }
    selectedIndex = 0;
    emptyCode = "CHANGELOG_CURRENT_PRERELEASE_SECTION_EMPTY";
  }
  const selected = headings[selectedIndex];
  if (selected === undefined || selected.index === undefined) {
    throw new Error("CHANGELOG_UNRELEASED_SECTION_MISSING");
  }
  const contentStart = selected.index + selected[0].length;
  const contentEnd = headings[selectedIndex + 1]?.index ?? changelog.length;
  const content = changelog.slice(contentStart, contentEnd).trim();
  if (content.length === 0) throw new Error(emptyCode);
  return content;
}

export function renderReleaseNotes(version: string, compatibility: Compatibility, changelog: string): Readonly<{
  notes: string;
  changelogSectionSha256: string;
}> {
  const section = currentChangelogSection(version, changelog);
  const notes = [
    `# WSR Execution ${version}`,
    "",
    "## What's new",
    "",
    section,
    "",
    "## Compatibility",
    "",
    ...Object.entries(compatibility).map(([key, value]) => `- \`${key}\`: \`${value}\``),
    "",
    "## Upgrade guide",
    "",
    `Install \`wsr-execution@${version}\` and \`wsr-dsh-intake@${version}\` as one lockstep upgrade.`,
    "",
  ].join("\n");
  return Object.freeze({ notes, changelogSectionSha256: sha256(section) });
}

export function assertReleaseNotes(notes: string, version: string): void {
  if (!notes.startsWith(`# WSR Execution ${version}\n`)) throw new Error("RELEASE_NOTES_VERSION_MISMATCH");
  for (const heading of REQUIRED) {
    if (!notes.includes(`\n## ${heading}\n`)) throw new Error("RELEASE_NOTES_SECTION_MISSING");
  }
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const file = path.resolve(process.argv[2] ?? "");
  const version = process.argv[3] ?? "";
  assertReleaseNotes(await readFile(file, "utf8"), version);
  process.stdout.write(`${JSON.stringify({ version, status: "PASS" })}\n`);
}
