import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REQUIRED = ["What's new", "Compatibility", "Upgrade guide"] as const;

type Compatibility = Readonly<Record<"node" | "dsh" | "workflowContract" | "observationContract", string>>;

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export function renderReleaseNotes(version: string, compatibility: Compatibility, changelog: string): Readonly<{
  notes: string;
  changelogSectionSha256: string;
}> {
  const heading = /^## \[Unreleased\][^\n]*\n/mu.exec(changelog);
  if (heading === null) throw new Error("CHANGELOG_UNRELEASED_SECTION_MISSING");
  const tail = changelog.slice(heading.index + heading[0].length);
  const nextHeading = /^## \[/mu.exec(tail);
  const section = tail.slice(0, nextHeading?.index ?? tail.length).trim();
  if (section.length === 0) throw new Error("CHANGELOG_UNRELEASED_SECTION_EMPTY");
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
