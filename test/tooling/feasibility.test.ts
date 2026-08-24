import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const projectRoot = path.resolve(import.meta.dirname, "../..");

interface PackageMetadata {
  readonly name: string;
  readonly version: string;
  readonly bin?: Readonly<Record<string, string>>;
  readonly types?: string;
  readonly exports?: Readonly<Record<string, unknown>>;
}

function packageMetadata(specifier: string, paths?: readonly string[]): PackageMetadata {
  const packagePath = require.resolve(specifier, paths === undefined ? undefined : { paths: [...paths] });
  return JSON.parse(readFileSync(packagePath, "utf8")) as PackageMetadata;
}

describe("I2-G00 selected substrate matrix", () => {
  it("binds exact Node and pnpm identities and enforces the qualified Git baseline", () => {
    const project = JSON.parse(readFileSync(path.join(projectRoot, "package.json"), "utf8")) as {
      readonly packageManager: string;
    };

    expect(process.versions.node).toBe("24.12.0");
    expect(project.packageManager).toBe("pnpm@11.23.0");

    const git = spawnSync("git", ["--version"], { encoding: "utf8", shell: false });
    expect(git.status).toBe(0);
    const match = /^git version (\d+)\.(\d+)\.(\d+)(?:\..*)?$/.exec(git.stdout.trim());
    expect(match).not.toBeNull();
    const major = Number(match![1]);
    const minor = Number(match![2]);
    const patch = Number(match![3]);
    expect(major > 2 || (major === 2 && (minor > 52 || (minor === 52 && patch >= 0)))).toBe(true);
  });

  it("binds DSH and its headless dependency to the same selected release", () => {
    const dshPath = require.resolve("@deepseek-ai/dsh/package.json");
    const dsh = packageMetadata("@deepseek-ai/dsh/package.json");
    const headless = packageMetadata("@deepseek-ai/dsh-headless/package.json", [path.dirname(dshPath)]);

    expect(dsh.version).toBe("0.1.1-rc.2");
    expect(headless.version).toBe(dsh.version);
  });

  it("proves native session re-entry and continued input on the selected public DSH package closure", () => {
    const dshPath = require.resolve("@deepseek-ai/dsh/package.json");
    const packageRoot = path.dirname(dshPath);
    const sessionPath = require.resolve("@deepseek-ai/dsh-session/package.json", { paths: [packageRoot] });
    const agentPath = require.resolve("@deepseek-ai/dsh-agent/package.json", { paths: [packageRoot] });
    const session = JSON.parse(readFileSync(sessionPath, "utf8")) as PackageMetadata;
    const agent = JSON.parse(readFileSync(agentPath, "utf8")) as PackageMetadata;
    const sessionTypes = readFileSync(path.resolve(path.dirname(sessionPath), session.types!), "utf8");
    const agentTypes = readFileSync(path.resolve(path.dirname(agentPath), agent.types!), "utf8");
    const runtimeTypes = readFileSync(path.resolve(path.dirname(agentPath), "lib/types/runtime-types.d.ts"), "utf8");

    expect(session.version).toBe("0.1.1-rc.2");
    expect(agent.version).toBe("0.1.1-rc.2");
    expect(session.exports?.["."]).toBeDefined();
    expect(agent.exports?.["."]).toBeDefined();
    expect(sessionTypes).toContain("static fromRestore");
    expect(sessionTypes).toContain("flush(session: Session)");
    expect(agentTypes).toContain("resume(options: ResumeAgentOptions)");
    expect(runtimeTypes).toContain("SessionStartSource = 'startup' | 'resume'");
    expect(runtimeTypes).toContain("whenIdle(): Promise<void>");
    expect(runtimeTypes).toContain("followup(message: UserMessage): void");
    expect(runtimeTypes).toContain("inject(message: UserMessage): void");
  });

  it("runs the selected DSH headless CLI without importing an ambient executable", () => {
    const dshPackagePath = require.resolve("@deepseek-ai/dsh/package.json");
    const dsh = packageMetadata("@deepseek-ai/dsh/package.json");
    const bin = dsh.bin?.dsh;
    expect(bin).toBeDefined();

    const result = spawnSync(process.execPath, [path.resolve(path.dirname(dshPackagePath), bin!), "--version"], {
      cwd: projectRoot,
      encoding: "utf8",
      env: process.env,
      shell: false,
    });

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("0.1.1-rc.2");
    expect(result.stderr).toBe("");
  });

  it("renders locked DSH launcher help without presenting it as a plugin command catalog", () => {
    const dshPackagePath = require.resolve("@deepseek-ai/dsh/package.json");
    const dsh = packageMetadata("@deepseek-ai/dsh/package.json");
    const bin = dsh.bin?.dsh;
    expect(bin).toBeDefined();

    const result = spawnSync(process.execPath, [path.resolve(path.dirname(dshPackagePath), bin!), "--help"], {
      cwd: projectRoot,
      encoding: "utf8",
      env: process.env,
      shell: false,
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Usage: dsh");
    expect(result.stdout).toContain("--profile");
    expect(result.stdout).not.toContain("/wsr");
  });

  it("binds DSH headless to an explicit cwd and scoped DSH_HOME before Agent activation", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "i2-g00-dsh-"));
    const workspace = path.join(directory, "worktree");
    const dshHome = path.join(directory, "dsh-home");
    mkdirSync(workspace);
    try {
      const dshPackagePath = require.resolve("@deepseek-ai/dsh/package.json");
      const dsh = packageMetadata("@deepseek-ai/dsh/package.json");
      const bin = dsh.bin?.dsh;
      expect(bin).toBeDefined();

      const result = spawnSync(
        process.execPath,
        [path.resolve(path.dirname(dshPackagePath), bin!), "--profile", "headless"],
        {
          cwd: workspace,
          encoding: "utf8",
          env: { ...process.env, DSH_HOME: dshHome },
          shell: false,
        },
      );

      expect(result.status).toBe(1);
      expect(`${result.stdout}\n${result.stderr}`).toContain("a task is required");
      expect(existsSync(path.join(dshHome, "profiles", "headless"))).toBe(true);
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it("persists and reads one LangGraph checkpoint through SQLite", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "i2-g00-sqlite-"));
    try {
      const State = Annotation.Root({ value: Annotation<number>() });
      const checkpointer = SqliteSaver.fromConnString(path.join(directory, "checkpoint.sqlite"));
      const graph = new StateGraph(State)
        .addNode("increment", (state) => ({ value: state.value + 1 }))
        .addEdge(START, "increment")
        .addEdge("increment", END)
        .compile({ checkpointer });
      const config = { configurable: { thread_id: "i2-g00-feasibility" } };

      const result = await graph.invoke({ value: 1 }, config);
      const snapshot = await graph.getState(config);

      expect(result).toEqual({ value: 2 });
      expect(snapshot.values).toEqual({ value: 2 });
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });
});
