import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createServer, type Server as HttpsServer } from "node:https";

import {
  dismissBlockingPrompts,
  dshExecutable,
  evaluate,
  launchBrowser,
  rpc,
  runDsh,
  submitBrowserCommand,
  waitFor,
  waitForWebUrl,
  type CdpConnection,
} from "./qualify-dsh-interactive-intake.js";
import { bindLocalPackageCandidate, ensureDshProfileInstallationPolicy } from "./dsh-profile-installation.js";

export interface DshProductQualificationOptions {
  readonly coreArchive: string;
  readonly pluginArchive: string;
  readonly sourceConfigFile: string;
  readonly workflowAssetsDirectory?: string;
}

export const dshProductQualificationSelectors = Object.freeze({
  hello: "hello-world-workflow",
  systemDesign: "system-design-workflow",
  implementation: "implementation-workflow",
  exactRegression: "hello-world-workflow@0.2.0",
});

const QUALIFICATION_REPOSITORY_ROLES = Object.freeze([
  "role.greeter",
  "role.reviewer",
  "role.grilling-facilitator",
  "role.evidence-scout",
  "role.system-designer",
  "role.architecture-reviewer",
  "role.problem-solution-reviewer",
  "role.quality-reviewer",
  "role.finding-aggregator",
  "role.fresh-reader",
  "role.goal-facilitator",
  "role.implementation-feasibility-validator",
  "role.test-designer",
  "role.implementer",
  "role.goal-adversary",
  "role.implementation-reviewer",
  "role.delivery-custodian",
]);

function qualificationRoleBindings(roles: readonly string[]) {
  return Object.freeze({
    schemaVersion: "execution.repository-role-provider-bindings@1.0.0",
    bindings: Object.fromEntries(roles.map((role) => [role, {
      agentProvider: { identity: "provider.copilot", version: "1.0.78" },
      model: { provider: "github-copilot", model: "gpt-5.3-codex" },
    }])),
  });
}

export function dshProductQualificationPatch(configFile: string, bindingFile: string): string {
  return [
    "- id: workflow-execution",
    "  config:",
    `    configFile: ${JSON.stringify(configFile)}`,
    `    bindingFile: ${JSON.stringify(bindingFile)}`,
    "",
  ].join("\n");
}

export function prepareDshProductQualificationConfig(
  source: Record<string, any>,
  paths: Readonly<{ repositoryRoot: string; stateRoot: string }>,
): Record<string, any> {
  const config = structuredClone(source);
  config.paths = {
    ...config.paths,
    repositoryRoot: paths.repositoryRoot,
    workspaceRoot: paths.repositoryRoot,
    allowedWorktreeRoots: [paths.repositoryRoot],
    stateRoot: paths.stateRoot,
  };
  config.controls = { ...config.controls, executionTimeoutMs: 600_000 };
  return config;
}

export function manifestWorkflowPackage(manifest: Record<string, any>): Readonly<{
  name: string;
  exactVersion: string;
}> | undefined {
  const candidate = manifest.schemaVersion === "execution.delivery-manifest@2.0.0"
    ? manifest.workflowPackage
    : undefined;
  return candidate !== null && typeof candidate === "object"
    && typeof candidate.name === "string" && typeof candidate.exactVersion === "string"
    ? Object.freeze({ name: candidate.name, exactVersion: candidate.exactVersion })
    : undefined;
}

export function dshProductQualificationPaths(root: string) {
  const qualificationRoot = path.resolve(root);
  const workspaceRoot = path.join(qualificationRoot, "workspace-root");
  return Object.freeze({
    launchDirectory: path.join(qualificationRoot, "dsh-launch"),
    workspaceRoot,
    helloWorktree: path.join(workspaceRoot, "hello-worktree"),
    systemWorktree: path.join(workspaceRoot, "system-worktree"),
    implementationWorktree: path.join(workspaceRoot, "implementation-worktree"),
    abandonWorktree: path.join(workspaceRoot, "abandon-worktree"),
    outsideWorktree: path.join(qualificationRoot, "out-of-scope-worktree"),
  });
}

export function containsInternalActionProtocol(text: string): boolean {
  return /tool-call|workflow_complete|"arguments"|call_[A-Za-z0-9_-]+/u.test(text);
}

export interface DirtyQualificationBaseline {
  readonly indexDigest: string;
  readonly trackedContent: string;
  readonly untrackedContent: string;
  readonly ignoredContent: Buffer;
  readonly ignoredBlobId: string;
}

function gitOutput(worktree: string, args: readonly string[]): string {
  return execFileSync("git", [...args], { cwd: worktree, encoding: "utf8" }).trim();
}

function objectExistsInUserOdb(worktree: string, objectId: string): boolean {
  try {
    execFileSync("git", ["cat-file", "-e", objectId], { cwd: worktree, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export async function prepareDirtyQualificationWorkspace(worktree: string): Promise<DirtyQualificationBaseline> {
  const nonce = randomUUID();
  const trackedContent = `dirty tracked qualification ${nonce}\n`;
  const untrackedContent = `managed untracked qualification ${nonce}\n`;
  const ignoredContent = Buffer.concat([
    Buffer.from(`ignored qualification cache ${nonce}\n`),
    Buffer.alloc(8 * 1024 * 1024, 0x5a),
  ]);
  await writeFile(path.join(worktree, "README.md"), trackedContent);
  await writeFile(path.join(worktree, "managed-untracked.txt"), untrackedContent);
  await mkdir(path.join(worktree, "ignored-cache"), { recursive: true });
  await writeFile(path.join(worktree, "ignored-cache", "large-cache.bin"), ignoredContent);
  const ignoredBlobId = gitOutput(worktree, ["hash-object", "ignored-cache/large-cache.bin"]);
  if (objectExistsInUserOdb(worktree, ignoredBlobId)) throw new Error("PRODUCT_DIRTY_IGNORED_BASELINE_ALREADY_IN_USER_ODB");
  return Object.freeze({
    indexDigest: createHash("sha256").update(await readFile(path.join(worktree, ".git", "index"))).digest("hex"),
    trackedContent,
    untrackedContent,
    ignoredContent,
    ignoredBlobId,
  });
}

export async function verifyDirtyQualificationWorkspace(worktree: string, baseline: DirtyQualificationBaseline) {
  const indexDigest = createHash("sha256").update(await readFile(path.join(worktree, ".git", "index"))).digest("hex");
  return Object.freeze({
    indexUnchanged: indexDigest === baseline.indexDigest,
    managedDirtyPreserved: (await readFile(path.join(worktree, "README.md"), "utf8")) === baseline.trackedContent
      && (await readFile(path.join(worktree, "managed-untracked.txt"), "utf8")) === baseline.untrackedContent,
    ignoredCachePreserved: (await readFile(path.join(worktree, "ignored-cache", "large-cache.bin"))).equals(baseline.ignoredContent),
    ignoredBlobAbsentFromUserOdb: !objectExistsInUserOdb(worktree, baseline.ignoredBlobId),
  });
}

async function startDsh(dshHome: string, worktree: string): Promise<Readonly<{ child: ChildProcess; url: URL }>> {
  const child = spawn(process.execPath, [dshExecutable(), "--profile", "web", "--port", "0", "--no-open"], {
    cwd: worktree,
    env: { ...process.env, DSH_HOME: dshHome },
    stdio: ["ignore", "pipe", "pipe"],
  });
  return Object.freeze({ child, url: await waitForWebUrl(child) });
}

async function stop(child: ChildProcess | undefined): Promise<void> {
  if (child !== undefined && child.exitCode === null) {
    child.kill("SIGTERM");
    await new Promise<void>((resolve) => child.once("exit", () => resolve()));
  }
}

async function startWorkflowAssetServer(root: string, assetsDirectory: string): Promise<Readonly<{
  server: HttpsServer;
  releasesBaseUrl: string;
  certificate: string;
}>> {
  const certificate = path.join(root, "workflow-assets.crt");
  const key = path.join(root, "workflow-assets.key");
  execFileSync("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
    "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1",
    "-keyout", key, "-out", certificate,
  ], { stdio: "ignore" });
  const metadata = JSON.parse(await readFile(path.join(assetsDirectory, "release-metadata.json"), "utf8")) as {
    readonly packages: readonly Readonly<{ tag: string; assets: readonly Readonly<{ name: string }>[] }>[];
  };
  let origin = "";
  const server = createServer({ key: await readFile(key), cert: await readFile(certificate) }, (request, response) => {
    const url = new URL(request.url ?? "/", origin);
    if (url.pathname === "/releases") {
      const releases = metadata.packages.map((item) => ({
        tag_name: item.tag,
        draft: false,
        prerelease: false,
        assets: item.assets.map(({ name }) => ({ name, browser_download_url: `${origin}/assets/${encodeURIComponent(name)}` })),
      }));
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(releases));
      return;
    }
    const match = /^\/assets\/([^/]+)$/u.exec(url.pathname);
    const name = match?.[1] === undefined ? undefined : decodeURIComponent(match[1]);
    if (name === undefined || path.basename(name) !== name) {
      response.writeHead(404).end();
      return;
    }
    readFile(path.join(assetsDirectory, name)).then(
      (bytes) => { response.writeHead(200, { "content-type": "application/octet-stream" }); response.end(bytes); },
      () => { response.writeHead(404).end(); },
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("PRODUCT_WORKFLOW_ASSET_SERVER_UNAVAILABLE");
  origin = `https://localhost:${String(address.port)}`;
  return Object.freeze({ server, releasesBaseUrl: `${origin}/releases`, certificate });
}

async function selectWorkspace(cdp: CdpConnection, url: URL, worktree: string): Promise<string> {
  const created = await rpc(url, "workspace.create", { path: worktree });
  if (created.ok !== true || typeof created.value?.workspace?.workspaceId !== "string") throw new Error("PRODUCT_WORKSPACE_CREATE_FAILED");
  const title = created.value.workspace.title as string;
  const state = await waitFor(async () => {
    const ready = await evaluate(cdp, `(() => {
      const button = [...document.querySelectorAll('button')].find((candidate) => /^(继续|Continue|稍后配置|Later|Skip for now)$/u.test(candidate.textContent?.trim() ?? ''));
      if (button) { button.click(); return undefined; }
      if (document.querySelector('#root')?.hasAttribute('inert') !== false) return undefined;
      if ([...document.querySelectorAll('button')].some((candidate) => /^(选择工作区|Select workspace)$/u.test(candidate.textContent?.trim() ?? ''))) return 'picker';
      if (document.querySelector('[data-wsr-sidebar-resources="true"]')) return 'active';
      if (document.querySelector('textarea,[contenteditable="true"]')) return 'active';
      return undefined;
    })()`);
    return ready === "picker" || ready === "active" ? ready : undefined;
  }, "PRODUCT_BROWSER_ONBOARDING_UNAVAILABLE", 40_000);
  if (state === "picker") {
    await waitFor(async () => await evaluate(cdp, `(() => {
      const button = [...document.querySelectorAll('button')].find((candidate) => /^(选择工作区|Select workspace)$/u.test(candidate.textContent?.trim() ?? ''));
      if (!button) return false;
      button.click();
      return true;
    })()`) === true ? true : undefined, "PRODUCT_WORKSPACE_PICKER_UNAVAILABLE");
    await waitFor(async () => await evaluate(cdp, `(() => {
      const title = ${JSON.stringify(title)};
      const candidate = [...document.querySelectorAll('button,[role="button"]')].find((element) =>
        (element.textContent?.trim() ?? '').includes(title) && !/^(选择工作区|Select workspace)$/u.test(element.textContent?.trim() ?? ''));
      if (!candidate) return false;
      candidate.click();
      return true;
    })()`) === true ? true : undefined, "PRODUCT_WORKSPACE_OPTION_UNAVAILABLE", 40_000);
  } else {
    await cdp.call("Page.reload", { ignoreCache: true });
    await waitFor(async () => {
      const response = await cdp.call("Runtime.evaluate", { expression: "document.readyState", returnByValue: true }) as any;
      return response.result?.value === "complete" ? true : undefined;
    }, "PRODUCT_WORKSPACE_SWITCH_RELOAD_TIMEOUT", 40_000);
    await dismissBlockingPrompts(cdp);
    await waitFor(async () => await evaluate(cdp, `(() => {
      const openSidebar = [...document.querySelectorAll('button')].find((candidate) => /^(打开侧边栏|Open sidebar)$/u.test(candidate.getAttribute('aria-label') ?? ''));
      if (openSidebar) openSidebar.click();
      const title = ${JSON.stringify(title)};
      const createSession = [...document.querySelectorAll('button')].find((candidate) => {
        const label = candidate.getAttribute('aria-label') ?? '';
        return label.includes(title) && /新建会话|New session/u.test(label);
      });
      if (!createSession) return false;
      createSession.click();
      return true;
    })()`) === true ? true : undefined, "PRODUCT_WORKSPACE_SESSION_SWITCH_UNAVAILABLE", 40_000);
  }
  await dismissBlockingPrompts(cdp);
  await waitFor(async () => await evaluate(cdp,
    `document.body?.innerText?.includes(${JSON.stringify(title)}) === true`) === true ? true : undefined,
  "PRODUCT_WORKSPACE_SELECTION_FAILED", 40_000);
  return created.value.workspace.workspaceId;
}

async function reopenWorkspace(cdp: CdpConnection, url: URL, workspaceId: string): Promise<void> {
  await dismissBlockingPrompts(cdp);
  const listed = await rpc(url, "workspace.list", {});
  const existing = listed.value?.items?.find((entry: any) => entry.workspaceId === workspaceId);
  if (listed.ok !== true || typeof existing?.title !== "string") throw new Error("PRODUCT_RESTART_WORKSPACE_MISSING");
  const state = await waitFor(async () => await evaluate(cdp, `(() => {
    const title = ${JSON.stringify(existing.title)};
    const text = document.body?.innerText ?? '';
    const activeInput = [...document.querySelectorAll('textarea,[contenteditable="true"]')].some((element) => {
      const style = window.getComputedStyle(element);
      return style.display !== 'none' && style.visibility !== 'hidden'
        && !element.hasAttribute('disabled') && element.getAttribute('aria-disabled') !== 'true';
    });
    if ((text.includes(title) && document.querySelector('[data-wsr-sidebar-resources="true"]')) || activeInput) return 'restored';
    if (/选择工作区|Select workspace/u.test(text)) return 'picker';
    return undefined;
  })()`), "PRODUCT_BROWSER_RESTART_STATE_UNAVAILABLE", 40_000);
  if (state === "restored") return;
  await waitFor(async () => await evaluate(cdp, `(() => {
    const button = [...document.querySelectorAll('button')].find((candidate) => /^(选择工作区|Select workspace)$/u.test(candidate.textContent?.trim() ?? ''));
    if (!button) return false;
    button.click();
    return true;
  })()`) === true ? true : undefined, "PRODUCT_RESTART_WORKSPACE_PICKER_UNAVAILABLE", 40_000);
  await waitFor(async () => await evaluate(cdp, `(() => {
    const title = ${JSON.stringify(existing.title)};
    const candidate = [...document.querySelectorAll('button,[role="button"]')].find((element) =>
      (element.textContent?.trim() ?? '').includes(title) && !/^(选择工作区|Select workspace)$/u.test(element.textContent?.trim() ?? ''));
    if (!candidate) return false;
    candidate.click();
    return true;
  })()`) === true ? true : undefined, "PRODUCT_RESTART_WORKSPACE_OPTION_UNAVAILABLE", 40_000);
  await dismissBlockingPrompts(cdp);
  await waitFor(async () => await evaluate(cdp,
    `document.body?.innerText?.includes(${JSON.stringify(existing.title)}) === true`) === true ? true : undefined,
  "PRODUCT_RESTART_WORKSPACE_SELECTION_FAILED", 40_000);
}

async function reopenConversation(cdp: CdpConnection, title: string): Promise<void> {
  await dismissBlockingPrompts(cdp);
  await waitFor(async () => await evaluate(cdp, `(() => {
    const openSidebar = [...document.querySelectorAll('button')].find((candidate) =>
      /^(打开侧边栏|Open sidebar)$/u.test(candidate.getAttribute('aria-label') ?? ''));
    if (openSidebar) openSidebar.click();
    const title = ${JSON.stringify(title)};
    const candidate = [...document.querySelectorAll('button,[role="button"]')].find((element) =>
      (element.textContent?.trim() ?? '') === title || (element.getAttribute('aria-label') ?? '').includes(title));
    if (!candidate) return false;
    candidate.click();
    return true;
  })()`) === true ? true : undefined, "PRODUCT_EXISTING_SESSION_UNAVAILABLE", 40_000);
  await waitFor(async () => await evaluate(cdp,
    `document.body?.innerText?.includes(${JSON.stringify(title)}) === true`) === true ? true : undefined,
  "PRODUCT_EXISTING_SESSION_NOT_OPENED", 40_000);
}

async function sessionId(url: URL, workspaceId: string): Promise<string> {
  return waitFor(async () => {
    const listed = await rpc(url, "workspace.list", {});
    const selected = listed.value?.items?.find((entry: any) => entry.workspaceId === workspaceId);
    const id = selected?.sessionIds?.at(0);
    return listed.ok === true && typeof id === "string" ? id : undefined;
  }, "PRODUCT_SESSION_UNAVAILABLE", 40_000);
}

async function observe(cdp: CdpConnection): Promise<void> {
  await evaluate(cdp, `window.__wsrProductEvents = []; new MutationObserver(() => {
    for (const element of document.querySelectorAll('[data-wsr-presentation="true"]')) {
      const event = {
        kind: element.getAttribute('data-wsr-kind'),
        correlation: element.getAttribute('data-wsr-correlation'),
        surface: element.getAttribute('data-wsr-surface'),
        chatRole: element.getAttribute('data-wsr-chat-role'),
        role: element.getAttribute('role'),
        tag: element.tagName.toLowerCase(),
        text: element.textContent
      };
      if (!window.__wsrProductEvents.some((candidate) => JSON.stringify(candidate) === JSON.stringify(event))) window.__wsrProductEvents.push(event);
    }
  }).observe(document.documentElement, { childList: true, subtree: true, attributes: true }); true`);
}

async function events(cdp: CdpConnection): Promise<Array<{ kind: string; correlation: string; surface: string; chatRole: string | null; role: string | null; tag: string; text: string }>> {
  return await evaluate(cdp, "window.__wsrProductEvents ?? []");
}

async function waitForKind(cdp: CdpConnection, kind: string, after = 0, timeoutMs = 240_000, surface?: "chat" | "sidebar") {
  return waitFor(async () => {
    const observed = await events(cdp);
    const matching = observed.filter((event) => event.kind === kind && (surface === undefined || event.surface === surface));
    return matching.length > after ? matching.at(-1) : undefined;
  }, `PRODUCT_PRESENTATION_MISSING:${kind}`, timeoutMs);
}

async function waitForEitherKind(cdp: CdpConnection, kinds: readonly string[], after: Readonly<Record<string, number>>, timeoutMs: number) {
  return waitFor(async () => {
    const observed = (await events(cdp)).filter((event) => event.surface === "chat");
    for (const kind of kinds) {
      const matching = observed.filter((event) => event.kind === kind);
      if (matching.length > (after[kind] ?? 0)) return matching.at(-1);
    }
    return undefined;
  }, `PRODUCT_PRESENTATION_MISSING:${kinds.join("|")}`, timeoutMs);
}

async function clickWsrCurrentStatus(cdp: CdpConnection): Promise<void> {
  await waitFor(async () => await evaluate(cdp, `(() => {
    const status = [...document.querySelectorAll('[data-wsr-sidebar="true"] button')]
      .find((candidate) => candidate.textContent?.trim() === 'Current status');
    if (status) {
      status.click();
      return true;
    }
    const action = [...document.querySelectorAll('button')].find((candidate) =>
      candidate.textContent?.trim() === 'WSR' || candidate.getAttribute('aria-label') === 'WSR');
    if (action) action.click();
    return false;
  })()`) === true ? true : undefined, "PRODUCT_WSR_CURRENT_STATUS_UNAVAILABLE", 40_000);
}

async function attach(cdp: CdpConnection, filename: string): Promise<void> {
  const data = (await readFile(filename)).toString("base64");
  const pasted = await evaluate(cdp, `(() => {
    const textarea = document.querySelector('textarea');
    if (!(textarea instanceof HTMLTextAreaElement)) return false;
    const bytes = Uint8Array.from(atob(${JSON.stringify(data)}), (character) => character.charCodeAt(0));
    const file = new File([bytes], ${JSON.stringify(path.basename(filename))}, { type: 'image/png' });
    const transfer = new DataTransfer();
    transfer.items.add(file);
    textarea.focus();
    textarea.dispatchEvent(new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }));
    return true;
  })()`);
  if (pasted !== true) throw new Error("PRODUCT_ATTACHMENT_PASTE_UNAVAILABLE");
  await waitFor(async () => await evaluate(cdp,
    `document.querySelectorAll('[data-composer-card] img[src^="blob:"], [data-composer-card] img[src^="data:"]').length > 0`) === true ? true : undefined,
  "PRODUCT_ATTACHMENT_NOT_VISIBLE", 40_000);
}

async function initializeQualificationWorktree(worktree: string, title: string, roles: readonly string[] = []): Promise<void> {
  await mkdir(worktree, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: worktree });
  execFileSync("git", ["config", "user.email", "qualification@example.invalid"], { cwd: worktree });
  execFileSync("git", ["config", "user.name", "Qualification"], { cwd: worktree });
  await writeFile(path.join(worktree, "README.md"), `# ${title}\n\nA minimal repository for product E2E.\n`);
  await writeFile(path.join(worktree, ".gitignore"), "ignored-cache/\n");
  if (roles.length > 0) {
    await mkdir(path.join(worktree, ".wsr"));
    await writeFile(path.join(worktree, ".wsr", "role-provider-bindings.json"), `${JSON.stringify(qualificationRoleBindings(roles), null, 2)}\n`);
  }
  execFileSync("git", ["add", "."], { cwd: worktree });
  execFileSync("git", ["commit", "-qm", "baseline"], { cwd: worktree });
}

export async function qualifyDshProductE2e(options: DshProductQualificationOptions) {
  const root = await mkdtemp(path.join(tmpdir(), "execution-dsh-product-"));
  const layout = dshProductQualificationPaths(root);
  const dshHome = path.join(root, "dsh-home");
  const durable = path.join(root, "durable");
  const configFile = path.join(durable, "execution.json");
  const bindingFile = path.join(durable, "intake-bindings.json");
  const attachmentFile = path.join(root, "wave6-attachment.png");
  let dsh: ChildProcess | undefined;
  let chrome: ChildProcess | undefined;
  let cdp: CdpConnection | undefined;
  let workflowAssets: Awaited<ReturnType<typeof startWorkflowAssetServer>> | undefined;
  const previousExtraCa = process.env.NODE_EXTRA_CA_CERTS;
  try {
    await Promise.all([
      mkdir(layout.launchDirectory, { recursive: true }),
      mkdir(path.join(durable, "state"), { recursive: true }),
      initializeQualificationWorktree(layout.helloWorktree, "Hello qualification", QUALIFICATION_REPOSITORY_ROLES),
      initializeQualificationWorktree(layout.systemWorktree, "System design qualification", QUALIFICATION_REPOSITORY_ROLES),
      initializeQualificationWorktree(layout.implementationWorktree, "Implementation qualification", QUALIFICATION_REPOSITORY_ROLES),
      initializeQualificationWorktree(layout.abandonWorktree, "Abandon qualification", QUALIFICATION_REPOSITORY_ROLES),
      initializeQualificationWorktree(layout.outsideWorktree, "Exact registered workspace qualification"),
    ]);
    const helloDirtyBaseline = await prepareDirtyQualificationWorkspace(layout.helloWorktree);
    const [canonicalLaunchDirectory, canonicalWorkspaceRoot, canonicalHelloWorktree, canonicalSystemWorktree, canonicalImplementationWorktree, canonicalAbandonWorktree, canonicalOutsideWorktree] = await Promise.all([
      realpath(layout.launchDirectory), realpath(layout.workspaceRoot), realpath(layout.helloWorktree),
      realpath(layout.systemWorktree), realpath(layout.implementationWorktree), realpath(layout.abandonWorktree), realpath(layout.outsideWorktree),
    ]);
    await writeFile(attachmentFile, Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64",
    ));
    const sourceConfig = JSON.parse(await readFile(path.resolve(options.sourceConfigFile), "utf8"));
    if (options.workflowAssetsDirectory !== undefined) {
      workflowAssets = await startWorkflowAssetServer(root, path.resolve(options.workflowAssetsDirectory));
      sourceConfig.workflowSource.releasesBaseUrl = workflowAssets.releasesBaseUrl;
      process.env.NODE_EXTRA_CA_CERTS = workflowAssets.certificate;
    }
    const qualificationConfig = prepareDshProductQualificationConfig(sourceConfig, {
      repositoryRoot: canonicalWorkspaceRoot,
      stateRoot: path.join(durable, "state"),
    });
    await writeFile(configFile, `${JSON.stringify(qualificationConfig, null, 2)}\n`);
    await ensureDshProfileInstallationPolicy("web", (args) => runDsh(dshHome, canonicalLaunchDirectory, args));
    const coreManifest = JSON.parse(await readFile(path.join(import.meta.dirname, "../package.json"), "utf8")) as { readonly version: string };
    await bindLocalPackageCandidate(
      path.join(dshHome, "profiles/web"),
      "wsr-execution",
      coreManifest.version,
      path.resolve(options.coreArchive),
    );
    runDsh(dshHome, canonicalLaunchDirectory, ["plugin", "--profile", "web", "add", "--workspace-root", path.resolve(options.coreArchive)]);
    runDsh(dshHome, canonicalLaunchDirectory, ["plugin", "--profile", "web", "add", "--workspace-root", path.resolve(options.pluginArchive)]);
    await writeFile(path.join(dshHome, "profiles/web/cordis.patch.yml"), dshProductQualificationPatch(configFile, bindingFile));

    const started = await startDsh(dshHome, canonicalLaunchDirectory);
    dsh = started.child;
    const browser = await launchBrowser(root, started.url);
    chrome = browser.child;
    cdp = browser.cdp;
    const outsideWorkspaceId = await selectWorkspace(cdp, started.url, canonicalOutsideWorktree);
    const outsideSession = await sessionId(started.url, outsideWorkspaceId);
    await observe(cdp);

    const admissionCommand = "/wsr create missing-workflow-for-workspace-admission@0.0.0\nThis exact registered workspace request must remain visible.";
    await submitBrowserCommand(cdp, admissionCommand);
    let admissionResult: Awaited<ReturnType<typeof waitForKind>>;
    try {
      admissionResult = await waitForKind(cdp, "error", 0, 40_000, "chat");
    } catch (cause) {
      const [observed, history, dom] = await Promise.all([
        events(cdp),
        rpc(started.url, "session.history", { sessionId: outsideSession }),
        evaluate(cdp, "({ text: (document.body?.innerText ?? '').slice(-6000) })"),
      ]);
      throw new Error(`PRODUCT_REGISTERED_WORKSPACE_DIAGNOSTIC:${JSON.stringify({ observed, history: history.value?.events?.slice(-20), dom })}`, { cause });
    }
    if (admissionResult.text.includes("WORKTREE_OUT_OF_SCOPE") || admissionResult.text.includes("DSH_INTAKE_WORKSPACE_UNAUTHORIZED")) {
      throw new Error(`PRODUCT_REGISTERED_WORKSPACE_NOT_ADMITTED:${admissionResult.text}`);
    }
    if (admissionResult.chatRole !== "assistant" || admissionResult.role !== "alert") throw new Error("PRODUCT_CHAT_OUTPUT_NOT_ASSISTANT_STYLE");
    await waitFor(async () => await evaluate(cdp!, `(() => {
      return [...document.querySelectorAll('*')].some((element) => element.textContent === ${JSON.stringify(admissionCommand)});
    })()`) === true ? true : undefined, "PRODUCT_FAILED_COMMAND_INPUT_MISSING", 40_000);
    const isolatedCommands = await evaluate(cdp, `([...document.querySelectorAll('*')]
      .filter((element) => element.textContent?.trim() === '/wsr')
      .map((element) => ({
        tag: element.tagName.toLowerCase(),
        className: element.className,
        parentText: element.parentElement?.textContent,
        grandparentText: element.parentElement?.parentElement?.textContent,
      })))`);
    if (isolatedCommands.some((element: any) => element.parentText?.trim() === "/wsr"
      && element.grandparentText?.trim() === "/wsr")) {
      throw new Error(`PRODUCT_INTERNAL_COMMAND_ROW_VISIBLE:${JSON.stringify(isolatedCommands)}`);
    }
    const admissionHistory = await rpc(started.url, "session.history", { sessionId: outsideSession });
    if (admissionHistory.ok !== true || !admissionHistory.value?.events?.some((entry: any) => entry.event?.type === "user/message"
      && entry.event?.data?.content?.some((block: any) => block.type === "text" && block.text === admissionCommand))) {
      throw new Error("PRODUCT_FAILED_COMMAND_USER_MESSAGE_MISSING");
    }
    const helloWorkspaceId = await selectWorkspace(cdp, started.url, canonicalHelloWorktree);
    const helloSession = await sessionId(started.url, helloWorkspaceId);
    await observe(cdp);

    const emptyEventsBefore = (await events(cdp)).filter((event) => event.surface === "sidebar");
    await submitBrowserCommand(cdp, "/wsr list");
    let emptyPresentation: Awaited<ReturnType<typeof waitForEitherKind>>;
    try {
      emptyPresentation = await waitForKind(cdp, "delivery-list", emptyEventsBefore.filter((event) => event.kind === "delivery-list").length, 40_000, "sidebar");
    } catch (cause) {
      const [observed, history, dom] = await Promise.all([
        events(cdp),
        rpc(started.url, "session.history", { sessionId: helloSession }),
        evaluate(cdp, `({
          title: document.title,
          text: (document.body?.innerText ?? '').slice(-4000),
          inputs: [...document.querySelectorAll('textarea,[contenteditable="true"]')].map((element) => ({
            tag: element.tagName, placeholder: element.getAttribute('placeholder'), ariaLabel: element.getAttribute('aria-label'), value: element.value ?? element.textContent
          }))
        })`),
      ]);
      throw new Error(`PRODUCT_EMPTY_RESULT_DIAGNOSTIC:${JSON.stringify({ observed, history: history.value?.events?.slice(-20), dom })}`, { cause });
    }
    if (!/No Workflow Deliveries/u.test(emptyPresentation.text)) throw new Error(`PRODUCT_EMPTY_RESULT_INVALID:${emptyPresentation.text}`);
    const emptyText = emptyPresentation.text;

    await attach(cdp, attachmentFile);
    const helloBefore = (await events(cdp)).filter((event) => event.surface === "chat");
    await submitBrowserCommand(cdp, `/wsr create ${dshProductQualificationSelectors.hello}\nGreet the Wave 4 reviewer and acknowledge the attachment.`);
    let helloTerminal: Awaited<ReturnType<typeof waitForEitherKind>>;
    try {
      helloTerminal = await waitForEitherKind(cdp, ["terminal-result", "error"], {
        "terminal-result": helloBefore.filter((event) => event.kind === "terminal-result").length,
        error: helloBefore.filter((event) => event.kind === "error").length,
      }, 300_000);
    } catch (cause) {
      const manifestDirectory = path.join(durable, "state", "manifests");
      const coordinatorRecords = await readdir(manifestDirectory).then(async (manifestNames) => {
        const records: unknown[] = [];
        for (const manifestName of manifestNames) {
          const coordinatorDirectory = path.join(durable, "state", "runner", path.basename(manifestName, ".json"), "coordinator");
          const entries = await readdir(coordinatorDirectory).catch(() => []);
          for (const entry of entries) {
            const value = JSON.parse(await readFile(path.join(coordinatorDirectory, entry), "utf8"));
            records.push({ manifestName, phase: value.phase, result: value.result });
          }
        }
        return records;
      }, () => []);
      const history = await rpc(started.url, "session.history", { sessionId: helloSession });
      throw new Error(`PRODUCT_HELLO_DIAGNOSTIC:${JSON.stringify({
        events: (await events(cdp)).slice(-30),
        history: history.value?.events?.slice(-30),
        coordinatorRecords,
      })}`, { cause });
    }
    if (helloTerminal.kind === "error") throw new Error(`PRODUCT_HELLO_FAILED:${helloTerminal.text}`);
    const helloEvents = (await events(cdp)).filter((event) => event.surface === "chat");
    for (const kind of ["command-accepted", "action-output", "terminal-result"]) {
      if (!helloEvents.some((event) => event.kind === kind)) throw new Error(`PRODUCT_HELLO_LIFECYCLE_MISSING:${kind}`);
    }
    const helloActionOutput = helloEvents.filter((event) => event.kind === "action-output").map((event) => event.text).join("\n");
    if (containsInternalActionProtocol(helloActionOutput)) {
      throw new Error(`PRODUCT_HELLO_INTERNAL_PROTOCOL_VISIBLE:${helloActionOutput}`);
    }
    if (!helloEvents.some((event) => event.text.includes(path.basename(attachmentFile)))
      && !helloEvents.some((event) => /attachment/i.test(event.text))) throw new Error("PRODUCT_HELLO_ATTACHMENT_NOT_OBSERVED");
    const helloManifestDirectory = path.join(durable, "state", "manifests");
    const helloManifest = await waitFor(async () => {
      for (const name of await readdir(helloManifestDirectory)) {
        const candidate = JSON.parse(await readFile(path.join(helloManifestDirectory, name), "utf8"));
        if (manifestWorkflowPackage(candidate)?.name === "hello-world-workflow") return candidate;
      }
      return undefined;
    }, "PRODUCT_HELLO_MANIFEST_NOT_CREATED", 40_000);
    if (helloManifest.canonicalWorktree !== canonicalHelloWorktree) throw new Error("PRODUCT_HELLO_WORKTREE_MISMATCH");
    const helloPackage = manifestWorkflowPackage(helloManifest);
    if (helloPackage?.exactVersion !== "0.2.0") {
      throw new Error(`PRODUCT_HELLO_BARE_SELECTOR_NOT_FROZEN:${JSON.stringify(helloPackage)}`);
    }

    const exactSession = helloSession;
    await observe(cdp);
    const exactBefore = (await events(cdp)).filter((event) => event.surface === "chat");
    const exactManifestsBefore = new Set(await readdir(helloManifestDirectory));
    await submitBrowserCommand(cdp, `/wsr create ${dshProductQualificationSelectors.exactRegression}\nReturn a concise exact-selector qualification result.`);
    const exactTerminal = await waitForEitherKind(cdp, ["terminal-result", "error"], {
      "terminal-result": exactBefore.filter((event) => event.kind === "terminal-result").length,
      error: exactBefore.filter((event) => event.kind === "error").length,
    }, 300_000);
    if (exactTerminal.kind === "error") throw new Error(`PRODUCT_EXACT_SELECTOR_FAILED:${exactTerminal.text}`);
    const exactManifest = await waitFor(async () => {
      for (const name of await readdir(helloManifestDirectory)) {
        if (exactManifestsBefore.has(name)) continue;
        const candidate = JSON.parse(await readFile(path.join(helloManifestDirectory, name), "utf8"));
        if (manifestWorkflowPackage(candidate)?.name === "hello-world-workflow") return candidate;
      }
      return undefined;
    }, "PRODUCT_EXACT_SELECTOR_MANIFEST_NOT_CREATED", 40_000);
    const exactPackage = manifestWorkflowPackage(exactManifest);
    if (exactPackage?.exactVersion !== "0.2.0") {
      throw new Error(`PRODUCT_EXACT_SELECTOR_NOT_FROZEN:${JSON.stringify(exactPackage)}`);
    }

    const implementationWorkspaceId = await selectWorkspace(cdp, started.url, canonicalImplementationWorktree);
    const implementationSession = await sessionId(started.url, implementationWorkspaceId);
    await observe(cdp);
    const implementationBefore = (await events(cdp)).filter((event) => event.surface === "chat");
    const implementationManifestsBefore = new Set(await readdir(helloManifestDirectory));
    await submitBrowserCommand(cdp, `/wsr create ${dshProductQualificationSelectors.implementation}\nInspect the repository and begin a bounded implementation qualification.`);
    const implementationManifest = await waitFor(async () => {
      for (const name of await readdir(helloManifestDirectory)) {
        if (implementationManifestsBefore.has(name)) continue;
        const candidate = JSON.parse(await readFile(path.join(helloManifestDirectory, name), "utf8"));
        if (manifestWorkflowPackage(candidate)?.name === "implementation-workflow") return candidate;
      }
      return undefined;
    }, "PRODUCT_IMPLEMENTATION_MANIFEST_NOT_CREATED", 120_000);
    const implementationPackage = manifestWorkflowPackage(implementationManifest);
    if (implementationPackage?.exactVersion !== "0.4.1"
      || implementationManifest.canonicalWorktree !== canonicalImplementationWorktree) {
      throw new Error(`PRODUCT_IMPLEMENTATION_BARE_SELECTOR_NOT_FROZEN:${JSON.stringify({
        package: implementationPackage,
        worktree: implementationManifest.canonicalWorktree,
      })}`);
    }
    const implementationAccepted = await waitForKind(cdp, "command-accepted",
      implementationBefore.filter((event) => event.kind === "command-accepted").length, 120_000, "chat");
    const implementationStarted = await waitForEitherKind(cdp, ["delivery-running", "terminal-result", "error"], {
      "delivery-running": implementationBefore.filter((event) => event.kind === "delivery-running").length,
      "terminal-result": implementationBefore.filter((event) => event.kind === "terminal-result").length,
      error: implementationBefore.filter((event) => event.kind === "error").length,
    }, 120_000);
    if (implementationStarted.kind === "error") throw new Error(`PRODUCT_IMPLEMENTATION_FAILED:${implementationStarted.text}`);

    const abandonWorkspaceId = await selectWorkspace(cdp, started.url, canonicalAbandonWorktree);
    const abandonSession = await sessionId(started.url, abandonWorkspaceId);
    await observe(cdp);
    await submitBrowserCommand(cdp, `/wsr create ${dshProductQualificationSelectors.systemDesign}\nEstablish the initial authority context for an abandon recovery qualification.`);
    const abandonBinding = await waitFor(async () => {
      try {
        const document = JSON.parse(await readFile(bindingFile, "utf8"));
        const binding = document.bindings?.find((entry: any) => entry.sessionKey === abandonSession && entry.state === "BOUND");
        if (binding === undefined) return undefined;
        const slots = await readdir(path.join(durable, "state", "current-slots"));
        for (const name of slots) {
          const slot = JSON.parse(await readFile(path.join(durable, "state", "current-slots", name), "utf8"));
          if (slot.deliveryId === binding.deliveryId && slot.worktree === canonicalAbandonWorktree) return binding;
        }
        return undefined;
      } catch { return undefined; }
    }, "PRODUCT_ABANDON_OCCUPIED_BINDING_NOT_OBSERVED", 120_000);
    const abandonCommandBefore = (await events(cdp)).filter((event) => event.surface === "chat");
    await submitBrowserCommand(cdp, "/wsr abandon");
    const abandoned = await waitForEitherKind(cdp, ["terminal-result", "error"], {
      "terminal-result": abandonCommandBefore.filter((event) => event.kind === "terminal-result").length,
      error: abandonCommandBefore.filter((event) => event.kind === "error").length,
    }, 120_000);
    if (abandoned.kind === "error") {
      const [history, bindingState, slotState] = await Promise.all([
        rpc(started.url, "session.history", { sessionId: abandonSession }),
        readFile(bindingFile, "utf8").then((value) => JSON.parse(value), () => undefined),
        readdir(path.join(durable, "state", "current-slots")).then(async (names) => Promise.all(names.map(async (name) =>
          JSON.parse(await readFile(path.join(durable, "state", "current-slots", name), "utf8")))), () => []),
      ]);
      throw new Error(`PRODUCT_ABANDON_FAILED:${JSON.stringify({
        presentation: abandoned.text,
        expectedBinding: abandonBinding,
        bindingState,
        slotState,
        history: history.value?.events?.slice(-30),
      })}`);
    }
    const abandonBindings = JSON.parse(await readFile(bindingFile, "utf8"));
    if (abandonBindings.bindings?.some((entry: any) => entry.sessionKey === abandonSession)) {
      throw new Error("PRODUCT_ABANDON_BINDING_NOT_CLEARED");
    }

    const systemWorkspaceId = await selectWorkspace(cdp, started.url, canonicalSystemWorktree);
    const systemSession = await sessionId(started.url, systemWorkspaceId);
    await observe(cdp);

    let firstInput: Awaited<ReturnType<typeof waitForEitherKind>> | undefined;
    let activeSystemManifestName: string | undefined;
    for (let attempt = 1; attempt <= 3 && firstInput === undefined; attempt += 1) {
      const before = (await events(cdp)).filter((event) => event.surface === "chat");
      const inputCount = before.filter((event) => event.kind === "action-input-request").length;
      const manifestDirectory = path.join(durable, "state", "manifests");
      const manifestsBefore = new Set(await readdir(manifestDirectory));
      await submitBrowserCommand(cdp, `/wsr create ${dshProductQualificationSelectors.systemDesign}\nDesign a local-only service that exposes one health endpoint. The intended users and measurable success criteria are deliberately unspecified so the Workflow must resolve a genuine product-level unknown. Qualification attempt ${String(attempt)}.`);
      let manifestName: string;
      try {
        manifestName = await waitFor(async () => {
          for (const name of await readdir(manifestDirectory)) {
            if (manifestsBefore.has(name)) continue;
            const manifest = JSON.parse(await readFile(path.join(manifestDirectory, name), "utf8"));
            if (manifestWorkflowPackage(manifest)?.name === "system-design-workflow") return name;
          }
          return undefined;
        }, "PRODUCT_SYSTEM_MANIFEST_NOT_CREATED", 120_000);
      } catch (cause) {
        const [diagnosticHistory, diagnosticSessions, diagnosticWorkspaces, diagnosticDom] = await Promise.all([
          rpc(started.url, "session.history", { sessionId: systemSession }),
          rpc(started.url, "session.list", {}),
          rpc(started.url, "workspace.list", {}),
          evaluate(cdp, "({ text: (document.body?.innerText ?? '').slice(-6000) })"),
        ]);
        throw new Error(`PRODUCT_SYSTEM_MANIFEST_NOT_CREATED:${JSON.stringify({
          history: diagnosticHistory.value?.events?.slice(-20),
          sessions: diagnosticSessions.value?.items,
          workspaces: diagnosticWorkspaces.value?.items,
          dom: diagnosticDom,
        })}`, { cause });
      }
      const coordinatorDirectory = path.join(durable, "state", "runner", path.basename(manifestName, ".json"), "coordinator");
      let disposition: Awaited<ReturnType<typeof events>>[number];
      try {
        disposition = await waitFor(async () => {
          const input = (await events(cdp!)).filter((event) => event.surface === "chat" && event.kind === "action-input-request");
          if (input.length > inputCount) return input.at(-1);
          try {
            for (const name of await readdir(coordinatorDirectory)) {
              const coordinator = JSON.parse(await readFile(path.join(coordinatorDirectory, name), "utf8"));
              if (coordinator.phase === "terminal") return {
                kind: "terminal-result", correlation: "durable", surface: "durable",
                chatRole: null, role: null, tag: "durable", text: "terminal",
              };
            }
          } catch { /* Coordinator may not be materialized yet. */ }
          return undefined;
        }, "PRODUCT_SYSTEM_ATTEMPT_UNRESOLVED", 660_000);
      } catch (cause) {
        const coordinatorRecords = await readdir(coordinatorDirectory).then(async (names) => Promise.all(names.map(async (name) => {
          try {
            const value = JSON.parse(await readFile(path.join(coordinatorDirectory, name), "utf8"));
            return { name, phase: value.phase, result: value.result, attempt: value.attempt };
          } catch { return { name, unreadable: true }; }
        })), () => []);
        const history = await rpc(started.url, "session.history", { sessionId: systemSession });
        throw new Error(`PRODUCT_SYSTEM_ATTEMPT_DIAGNOSTIC:${JSON.stringify({
          events: (await events(cdp)).slice(-30),
          history: history.value?.events?.slice(-30),
          coordinatorRecords,
        })}`, { cause });
      }
      if (disposition.kind === "action-input-request") {
        firstInput = disposition;
        activeSystemManifestName = manifestName;
      }
    }
    if (firstInput === undefined) throw new Error("PRODUCT_SYSTEM_INPUT_NOT_REQUESTED");
    if (activeSystemManifestName === undefined) throw new Error("PRODUCT_SYSTEM_MANIFEST_MISSING");
    const manifestDirectory = path.join(durable, "state", "manifests");
    const bindingDocumentBefore = JSON.parse(await readFile(bindingFile, "utf8"));
    const bindingBefore = bindingDocumentBefore.bindings?.find((entry: any) => entry.sessionKey === systemSession);
    if (bindingBefore === undefined) throw new Error("PRODUCT_SYSTEM_BINDING_MISSING");
    const manifestNames = await readdir(manifestDirectory);
    let systemManifestPath: string | undefined;
    for (const name of manifestNames) {
      const candidate = path.join(manifestDirectory, name);
      const manifest = JSON.parse(await readFile(candidate, "utf8"));
      if (manifest.deliveryId === bindingBefore.deliveryId && manifestWorkflowPackage(manifest)?.name === "system-design-workflow") systemManifestPath = candidate;
    }
    if (systemManifestPath === undefined) throw new Error("PRODUCT_SYSTEM_MANIFEST_MISSING");
    const activeSystemManifest = JSON.parse(await readFile(systemManifestPath, "utf8"));
    if (activeSystemManifest.canonicalWorktree !== canonicalSystemWorktree) throw new Error("PRODUCT_SYSTEM_WORKTREE_MISMATCH");
    const systemManifestBefore = await readFile(systemManifestPath);
    const firstHistory = await rpc(started.url, "session.history", { sessionId: systemSession });
    if (firstHistory.ok !== true) throw new Error("PRODUCT_SESSION_HISTORY_UNAVAILABLE");
    const sessionListBeforeRestart = await rpc(started.url, "session.list", {});
    const systemSessionTitle = sessionListBeforeRestart.value?.items?.find((entry: any) => entry.sessionId === systemSession)?.projections?.values?.title;
    if (sessionListBeforeRestart.ok !== true || typeof systemSessionTitle !== "string" || systemSessionTitle.length === 0) {
      throw new Error("PRODUCT_SYSTEM_SESSION_TITLE_UNAVAILABLE");
    }

    cdp.close();
    cdp = undefined;
    await stop(chrome);
    chrome = undefined;
    await stop(dsh);
    dsh = undefined;
    const restarted = await startDsh(dshHome, canonicalLaunchDirectory);
    dsh = restarted.child;
    const secondBrowser = await launchBrowser(root, restarted.url);
    chrome = secondBrowser.child;
    cdp = secondBrowser.cdp;
    await reopenWorkspace(cdp, restarted.url, systemWorkspaceId);
    await reopenConversation(cdp, systemSessionTitle);
    await observe(cdp);
    await clickWsrCurrentStatus(cdp);
    let recovered: Awaited<ReturnType<typeof events>>[number];
    try {
      recovered = await waitFor(async () => {
        const observed = await events(cdp!);
        return observed.findLast((event) => event.kind === "delivery-status" || event.kind === "error");
      }, "PRODUCT_RECOVERY_STATUS_UNAVAILABLE", 120_000);
    } catch (cause) {
      const history = await rpc(restarted.url, "session.history", { sessionId: systemSession });
      throw new Error(`PRODUCT_RECOVERY_STATUS_DIAGNOSTIC:${JSON.stringify({
        events: (await events(cdp)).slice(-30),
        history: history.value?.events?.slice(-30),
      })}`, { cause });
    }
    if (recovered.kind === "error") throw new Error(`PRODUCT_RECOVERY_STATUS_FAILED:${recovered.text}`);
    if (!/delivery|awaiting|running|recovery/i.test(recovered.text)) throw new Error(`PRODUCT_RECOVERY_STATUS_INVALID:${recovered.text}`);
    const bindingDocumentAfter = JSON.parse(await readFile(bindingFile, "utf8"));
    const bindingAfter = bindingDocumentAfter.bindings?.find((entry: any) => entry.sessionKey === systemSession);
    const bindingIdentity = (binding: any) => JSON.stringify({
      sessionKey: binding?.sessionKey,
      correlation: binding?.correlation,
      deliveryId: binding?.deliveryId,
      worktree: binding?.worktree,
    });
    if (!systemManifestBefore.equals(await readFile(systemManifestPath))
      || bindingIdentity(bindingBefore) !== bindingIdentity(bindingAfter)) {
      throw new Error("PRODUCT_DURABLE_BINDING_CHANGED");
    }

    const finalEvents = await events(cdp);
    const dirtyWorkspace = await verifyDirtyQualificationWorkspace(canonicalHelloWorktree, helloDirtyBaseline);
    if (Object.values(dirtyWorkspace).some((value) => value !== true)) {
      throw new Error(`PRODUCT_DIRTY_WORKSPACE_INVARIANT_FAILED:${JSON.stringify(dirtyWorkspace)}`);
    }
    const artifactDigest = async (filename: string) => `sha256:${createHash("sha256").update(await readFile(filename)).digest("hex")}`;
    return Object.freeze({
      result: "PASS",
      oracle: "browser-dom",
      url: started.url.href,
      environment: Object.freeze({ platform: process.platform, arch: process.arch, node: process.version, profile: "web" }),
      artifacts: Object.freeze({
        core: await artifactDigest(path.resolve(options.coreArchive)),
        plugin: await artifactDigest(path.resolve(options.pluginArchive)),
      }),
      empty: Object.freeze({ kind: "delivery-list", text: emptyText }),
      workspaceAuthority: Object.freeze({
        launchDirectory: canonicalLaunchDirectory,
        exactRegistered: Object.freeze({ sessionId: outsideSession, worktree: canonicalOutsideWorktree, admittedBeyondConfiguredRoots: true, result: admissionResult.text, inputPreserved: true }),
        hello: Object.freeze({ sessionId: helloSession, worktree: helloManifest.canonicalWorktree }),
        systemDesign: Object.freeze({ sessionId: systemSession, worktree: activeSystemManifest.canonicalWorktree }),
        implementation: Object.freeze({ sessionId: implementationSession, worktree: implementationManifest.canonicalWorktree }),
        abandon: Object.freeze({ sessionId: abandonSession, worktree: canonicalAbandonWorktree }),
      }),
      hello: Object.freeze({ terminal: helloTerminal.text, kinds: [...new Set(helloEvents.map((event) => event.kind))] }),
      exactSelector: Object.freeze({ sessionId: exactSession, terminal: exactTerminal.text, resolvedVersion: exactPackage.exactVersion }),
      implementation: Object.freeze({ accepted: implementationAccepted.text, started: implementationStarted.text, resolvedVersion: implementationPackage.exactVersion }),
      dirtyWorkspace,
      systemDesign: Object.freeze({ inputRequest: firstInput.text, actionScopedInputObserved: true }),
      recovery: Object.freeze({ status: recovered.text, manifestIdentityPreserved: true, bindingIdentityPreserved: true }),
      abandon: Object.freeze({ deliveryId: abandonBinding.deliveryId, terminal: abandoned.text, occupiedBindingObserved: true, withoutDeliveryId: true }),
      browserEvents: Object.freeze(finalEvents),
    });
  } finally {
    cdp?.close();
    await stop(chrome);
    await stop(dsh);
    if (workflowAssets !== undefined) await new Promise<void>((resolve) => workflowAssets!.server.close(() => resolve()));
    if (previousExtraCa === undefined) delete process.env.NODE_EXTRA_CA_CERTS;
    else process.env.NODE_EXTRA_CA_CERTS = previousExtraCa;
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [coreArchive, pluginArchive, sourceConfigFile, workflowAssetsDirectory] = process.argv.slice(2);
  if (coreArchive === undefined || pluginArchive === undefined || sourceConfigFile === undefined) {
    throw new TypeError("DSH_PRODUCT_QUALIFICATION_USAGE_INVALID");
  }
  process.stdout.write(`${JSON.stringify(await qualifyDshProductE2e({ coreArchive, pluginArchive, sourceConfigFile, workflowAssetsDirectory }), null, 2)}\n`);
}
