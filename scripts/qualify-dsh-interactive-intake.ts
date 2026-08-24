import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const repository = path.resolve(import.meta.dirname, "..");
const defaultWorktree = path.resolve(repository, "..");

function dshExecutable(): string {
  const manifestPath = require.resolve("@deepseek-ai/dsh/package.json");
  const manifest = require(manifestPath) as { readonly bin?: { readonly dsh?: string } };
  if (manifest.bin?.dsh === undefined) throw new TypeError("DSH_EXECUTABLE_UNAVAILABLE");
  return path.resolve(path.dirname(manifestPath), manifest.bin.dsh);
}

function runDsh(dshHome: string, cwd: string, args: readonly string[]): void {
  execFileSync(process.execPath, [dshExecutable(), ...args], {
    cwd,
    env: { ...process.env, DSH_HOME: dshHome },
    encoding: "utf8",
    stdio: "pipe",
  });
}

async function waitForWebUrl(child: ChildProcess): Promise<URL> {
  return await new Promise<URL>((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error(`DSH_WEB_START_TIMEOUT:${output.slice(-2_000)}`)), 30_000);
    const inspect = (chunk: Buffer | string) => {
      output += chunk.toString();
      const match = output.match(/dsh web:\s+(http:\/\/[^\s]+)/u);
      if (match?.[1] !== undefined) {
        clearTimeout(timer);
        resolve(new URL(match[1]));
      }
    };
    child.stdout?.on("data", inspect);
    child.stderr?.on("data", inspect);
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`DSH_WEB_EXITED:${String(code)}:${output.slice(-2_000)}`));
    });
  });
}

async function rpc(url: URL, method: string, payload: unknown): Promise<any> {
  const rpcId = `qualification-${method}`;
  const response = await fetch(new URL(`/api/${method}`, url), {
    method: "POST",
    headers: { "content-type": "application/json", origin: url.origin },
    body: JSON.stringify({ type: "client-request", rpcId, method, payload }),
  });
  if (response.status !== 200) throw new Error(`DSH_RPC_HTTP_${String(response.status)}`);
  const body = await response.json() as any;
  if (body.type !== "server-response" || body.rpcId !== rpcId) throw new Error("DSH_RPC_RESPONSE_INVALID");
  return body.result;
}

export async function qualifyDshInteractiveIntake(input: Readonly<{
  coreArchive: string;
  pluginArchive: string;
  worktree?: string;
}>): Promise<Readonly<{ command: string; result: "PASS" }>> {
  const coreArchive = path.resolve(input.coreArchive);
  const pluginArchive = path.resolve(input.pluginArchive);
  const worktree = path.resolve(input.worktree ?? defaultWorktree);
  const root = await mkdtemp(path.join(tmpdir(), "execution-dsh-interactive-"));
  const dshHome = path.join(root, "dsh-home");
  const durable = path.join(root, "durable");
  const configFile = path.join(durable, "execution.json");
  const bindingFile = path.join(durable, "intake-bindings.json");
  let child: ChildProcess | undefined;
  try {
    await mkdir(path.join(durable, "state"), { recursive: true });
    const defaults = JSON.parse(await readFile(path.join(repository, "config/defaults/execution.default.json"), "utf8"));
    defaults.paths = {
      repositoryRoot: worktree,
      workspaceRoot: path.dirname(worktree),
      allowedWorktreeRoots: [path.dirname(worktree)],
      stateRoot: path.join(durable, "state"),
      credentialStorePath: path.join(durable, "credentials.yml"),
    };
    defaults.runner.provider = {
      ...defaults.runner.provider,
      route: "qualification",
      modelId: "qualification-model",
      baseUrl: "https://example.invalid",
      credentialRef: "QUALIFICATION_KEY",
    };
    await Promise.all([
      writeFile(configFile, `${JSON.stringify(defaults, null, 2)}\n`, "utf8"),
      writeFile(defaults.paths.credentialStorePath, "version: 1\nrefs:\n  QUALIFICATION_KEY: unused-for-list\n", "utf8"),
    ]);
    runDsh(dshHome, worktree, ["plugin", "--profile", "web", "add", "--workspace-root", coreArchive]);
    runDsh(dshHome, worktree, ["plugin", "--profile", "web", "add", "--workspace-root", pluginArchive]);
    await writeFile(path.join(dshHome, "profiles/web/cordis.patch.yml"), [
      "- id: workflow-execution",
      "  config:",
      `    configFile: ${JSON.stringify(configFile)}`,
      `    bindingFile: ${JSON.stringify(bindingFile)}`,
      "",
    ].join("\n"), "utf8");
    child = spawn(process.execPath, [dshExecutable(), "--profile", "web", "--port", "0", "--no-open"], {
      cwd: worktree,
      env: { ...process.env, DSH_HOME: dshHome },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const webUrl = await waitForWebUrl(child);
    const page = await fetch(webUrl);
    if (page.status !== 200 || !(await page.text()).includes("<div id=\"root\"></div>")) throw new Error("DSH_WEB_PAGE_INVALID");
    const created = await rpc(webUrl, "session.create", { cwd: worktree });
    if (created.ok !== true || typeof created.value?.sessionId !== "string") throw new Error("DSH_SESSION_CREATE_FAILED");
    const sessionId = created.value.sessionId as string;
    const catalog = await rpc(webUrl, "commands/list", { args: { agentId: sessionId } });
    if (catalog.ok !== true || !catalog.value?.some((entry: any) => entry.name === "wsr")) throw new Error("DSH_WSR_COMMAND_MISSING");
    const executed = await rpc(webUrl, "commands/execute", { args: { agentId: sessionId, line: "/wsr list", images: [] } });
    if (executed.ok !== true || executed.value?.result?.kind !== "success"
      || !executed.value.result.text?.includes("deliveries")) throw new Error("DSH_WSR_COMMAND_FAILED");
    const history = await rpc(webUrl, "session.history", { sessionId });
    const events = history.value?.events?.filter((entry: any) => entry.event.type.startsWith("command/"));
    if (history.ok !== true || JSON.stringify(events?.map((entry: any) => entry.event.type)) !== JSON.stringify(["command/run", "command/done"])
      || !events?.[1]?.event?.data?.text?.includes("deliveries")) throw new Error("DSH_WSR_RESULT_NOT_DURABLE");
    return Object.freeze({ command: "/wsr list", result: "PASS" as const });
  } finally {
    if (child !== undefined && child.exitCode === null) {
      child.kill("SIGTERM");
      await new Promise<void>((resolve) => child!.once("exit", () => resolve()));
    }
    await rm(root, { recursive: true, force: true });
  }
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [coreArchive, pluginArchive, worktree] = process.argv.slice(2);
  if (coreArchive === undefined || pluginArchive === undefined) throw new TypeError("DSH_INTERACTIVE_QUALIFICATION_USAGE_INVALID");
  process.stdout.write(`${JSON.stringify(await qualifyDshInteractiveIntake({ coreArchive, pluginArchive, worktree }))}\n`);
}
