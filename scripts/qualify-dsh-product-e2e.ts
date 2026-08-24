import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

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
import { exerciseGrillingDialogue } from "./dsh-product-grilling-oracle.js";
import { ensureDshProfileInstallationPolicy } from "./dsh-profile-installation.js";

export interface DshProductQualificationOptions {
  readonly coreArchive: string;
  readonly pluginArchive: string;
  readonly sourceConfigFile: string;
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

async function selectWorkspace(cdp: CdpConnection, url: URL, worktree: string): Promise<string> {
  await waitFor(async () => {
    const ready = await evaluate(cdp, `(() => {
      const button = [...document.querySelectorAll('button')].find((candidate) => /^(继续|Continue|稍后配置|Later|Skip for now)$/u.test(candidate.textContent?.trim() ?? ''));
      if (button) { button.click(); return false; }
      return document.querySelector('#root')?.hasAttribute('inert') === false && /选择工作区|Select workspace/u.test(document.body?.innerText ?? '');
    })()`);
    return ready === true ? true : undefined;
  }, "PRODUCT_BROWSER_ONBOARDING_UNAVAILABLE", 40_000);
  const created = await rpc(url, "workspace.create", { path: worktree });
  if (created.ok !== true || typeof created.value?.workspace?.workspaceId !== "string") throw new Error("PRODUCT_WORKSPACE_CREATE_FAILED");
  await waitFor(async () => await evaluate(cdp, `(() => {
    const button = [...document.querySelectorAll('button')].find((candidate) => /^(选择工作区|Select workspace)$/u.test(candidate.textContent?.trim() ?? ''));
    if (!button) return false;
    button.click();
    return true;
  })()`) === true ? true : undefined, "PRODUCT_WORKSPACE_PICKER_UNAVAILABLE");
  const title = created.value.workspace.title as string;
  await waitFor(async () => await evaluate(cdp, `(() => {
    const title = ${JSON.stringify(title)};
    const candidate = [...document.querySelectorAll('button,[role="button"]')].find((element) =>
      (element.textContent?.trim() ?? '').includes(title) && !/^(选择工作区|Select workspace)$/u.test(element.textContent?.trim() ?? ''));
    if (!candidate) return false;
    candidate.click();
    return true;
  })()`) === true ? true : undefined, "PRODUCT_WORKSPACE_OPTION_UNAVAILABLE", 40_000);
  await dismissBlockingPrompts(cdp);
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
    if (text.includes(title) && document.querySelector('[data-wsr-sidebar="true"]')) return 'restored';
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

async function sessionId(url: URL, workspaceId: string): Promise<string> {
  return waitFor(async () => {
    const listed = await rpc(url, "workspace.list", {});
    const selected = listed.value?.items?.find((entry: any) => entry.workspaceId === workspaceId);
    const id = selected?.sessionIds?.at(-1);
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
        text: element.textContent
      };
      if (!window.__wsrProductEvents.some((candidate) => JSON.stringify(candidate) === JSON.stringify(event))) window.__wsrProductEvents.push(event);
    }
  }).observe(document.documentElement, { childList: true, subtree: true, attributes: true }); true`);
}

async function events(cdp: CdpConnection): Promise<Array<{ kind: string; correlation: string; surface: string; text: string }>> {
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

async function clickWsrTab(cdp: CdpConnection, label: "Deliveries" | "Current status"): Promise<void> {
  await waitFor(async () => await evaluate(cdp, `(() => {
    const label = ${JSON.stringify(label)};
    const button = [...document.querySelectorAll('[data-wsr-sidebar="true"] button')]
      .find((candidate) => candidate.textContent?.trim() === label);
    if (!button) return false;
    button.click();
    return true;
  })()`) === true ? true : undefined, `PRODUCT_SIDEBAR_TAB_UNAVAILABLE:${label}`, 40_000);
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

export async function qualifyDshProductE2e(options: DshProductQualificationOptions) {
  const root = await mkdtemp(path.join(tmpdir(), "execution-dsh-product-"));
  const dshHome = path.join(root, "dsh-home");
  const workspaceRoot = path.join(root, "workspace-root");
  const worktree = path.join(workspaceRoot, "worktree");
  const durable = path.join(root, "durable");
  const configFile = path.join(durable, "execution.json");
  const bindingFile = path.join(durable, "intake-bindings.json");
  const attachmentFile = path.join(root, "wave6-attachment.png");
  let dsh: ChildProcess | undefined;
  let chrome: ChildProcess | undefined;
  let cdp: CdpConnection | undefined;
  try {
    await Promise.all([mkdir(worktree, { recursive: true }), mkdir(path.join(durable, "state"), { recursive: true })]);
    execFileSync("git", ["init", "-q"], { cwd: worktree });
    execFileSync("git", ["config", "user.email", "qualification@example.invalid"], { cwd: worktree });
    execFileSync("git", ["config", "user.name", "Qualification"], { cwd: worktree });
    await writeFile(path.join(worktree, "README.md"), "# Wave 6 qualification\n\nA minimal repository for product E2E.\n");
    execFileSync("git", ["add", "README.md"], { cwd: worktree });
    execFileSync("git", ["commit", "-qm", "baseline"], { cwd: worktree });
    await writeFile(attachmentFile, Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64",
    ));
    const sourceConfig = JSON.parse(await readFile(path.resolve(options.sourceConfigFile), "utf8"));
    sourceConfig.paths = {
      ...sourceConfig.paths,
      repositoryRoot: worktree,
      workspaceRoot,
      allowedWorktreeRoots: [workspaceRoot],
      stateRoot: path.join(durable, "state"),
    };
    sourceConfig.controls = { ...sourceConfig.controls, executionTimeoutMs: 600_000 };
    await writeFile(configFile, `${JSON.stringify(sourceConfig, null, 2)}\n`);
    await ensureDshProfileInstallationPolicy("web", (args) => runDsh(dshHome, worktree, args));
    runDsh(dshHome, worktree, ["plugin", "--profile", "web", "add", "--workspace-root", path.resolve(options.coreArchive)]);
    runDsh(dshHome, worktree, ["plugin", "--profile", "web", "add", "--workspace-root", path.resolve(options.pluginArchive)]);
    await writeFile(path.join(dshHome, "profiles/web/cordis.patch.yml"), [
      "- id: workflow-execution",
      "  config:",
      `    configFile: ${JSON.stringify(configFile)}`,
      `    bindingFile: ${JSON.stringify(bindingFile)}`,
      "",
    ].join("\n"));

    const started = await startDsh(dshHome, worktree);
    dsh = started.child;
    const browser = await launchBrowser(root, started.url);
    chrome = browser.child;
    cdp = browser.cdp;
    const workspaceId = await selectWorkspace(cdp, started.url, worktree);
    const firstSession = await sessionId(started.url, workspaceId);
    await observe(cdp);

    await clickWsrTab(cdp, "Deliveries");
    const empty = await waitForKind(cdp, "delivery-list", 0, 40_000, "sidebar");
    if (!empty.text.includes("No Workflow Deliveries")) throw new Error(`PRODUCT_EMPTY_RESULT_INVALID:${empty.text}`);

    await attach(cdp, attachmentFile);
    await submitBrowserCommand(cdp, "/wsr create hello-world-workflow@0.1.0\nGreet the Wave 6 reviewer and acknowledge the attachment.");
    const helloTerminal = await waitForKind(cdp, "terminal-result", 0, 300_000, "chat");
    const helloEvents = (await events(cdp)).filter((event) => event.surface === "chat");
    for (const kind of ["command-accepted", "action-output", "terminal-result"]) {
      if (!helloEvents.some((event) => event.kind === kind)) throw new Error(`PRODUCT_HELLO_LIFECYCLE_MISSING:${kind}`);
    }
    if (!helloEvents.some((event) => event.text.includes(path.basename(attachmentFile)))
      && !helloEvents.some((event) => /attachment/i.test(event.text))) throw new Error("PRODUCT_HELLO_ATTACHMENT_NOT_OBSERVED");

    let firstInput: Awaited<ReturnType<typeof waitForEitherKind>> | undefined;
    let activeSystemManifestName: string | undefined;
    for (let attempt = 1; attempt <= 3 && firstInput === undefined; attempt += 1) {
      const before = (await events(cdp)).filter((event) => event.surface === "chat");
      const inputCount = before.filter((event) => event.kind === "action-input-request").length;
      const manifestDirectory = path.join(durable, "state", "manifests");
      const manifestsBefore = new Set(await readdir(manifestDirectory));
      await submitBrowserCommand(cdp, `/wsr create system-design-workflow@0.3.0\nThis qualification requires a grilling dialogue before completion. Before design work, you MUST call workflow_request_input to ask one question: which implementation stack to use. After the first external answer, ask one question: which local port to use. After the second external answer, ask one final confirmation question exactly: Have we reached agreement on this design? Do not call workflow_complete until the user explicitly confirms agreement. Qualification attempt ${String(attempt)}.`);
      const manifestName = await waitFor(async () => {
        for (const name of await readdir(manifestDirectory)) {
          if (manifestsBefore.has(name)) continue;
          const manifest = JSON.parse(await readFile(path.join(manifestDirectory, name), "utf8"));
          if (manifest.resolvedPackage?.name === "system-design-workflow") return name;
        }
        return undefined;
      }, "PRODUCT_SYSTEM_MANIFEST_NOT_CREATED", 120_000);
      const coordinatorDirectory = path.join(durable, "state", "runner", path.basename(manifestName, ".json"), "coordinator");
      const disposition = await waitFor(async () => {
        const input = (await events(cdp!)).filter((event) => event.surface === "chat" && event.kind === "action-input-request");
        if (input.length > inputCount) return input.at(-1);
        try {
          for (const name of await readdir(coordinatorDirectory)) {
            const coordinator = JSON.parse(await readFile(path.join(coordinatorDirectory, name), "utf8"));
            if (coordinator.phase === "terminal") return { kind: "terminal-result", correlation: "durable", surface: "durable", text: "terminal" };
          }
        } catch { /* Coordinator may not be materialized yet. */ }
        return undefined;
      }, "PRODUCT_SYSTEM_ATTEMPT_UNRESOLVED", 420_000);
      if (disposition.kind === "action-input-request") {
        firstInput = disposition;
        activeSystemManifestName = manifestName;
      }
    }
    if (firstInput === undefined) throw new Error("PRODUCT_SYSTEM_INPUT_NOT_REQUESTED");
    if (activeSystemManifestName === undefined) throw new Error("PRODUCT_SYSTEM_MANIFEST_MISSING");
    const activeCoordinatorDirectory = path.join(durable, "state", "runner", path.basename(activeSystemManifestName, ".json"), "coordinator");
    const firstQuestionCount = (await events(cdp)).filter((event) => event.surface === "chat" && event.kind === "action-input-request").length;
    let afterFinish: { readonly kind: string } | undefined;
    const grilling = await exerciseGrillingDialogue({
      firstQuestion: firstInput,
      firstQuestionCount,
      waitForNextQuestion: async (afterQuestionCount) => {
        const next = await waitFor(async () => {
          const input = (await events(cdp!)).filter((event) => event.surface === "chat" && event.kind === "action-input-request");
          if (input.length > afterQuestionCount) return input.at(-1);
          try {
            for (const name of await readdir(activeCoordinatorDirectory)) {
              const coordinator = JSON.parse(await readFile(path.join(activeCoordinatorDirectory, name), "utf8"));
              if (coordinator.phase === "terminal") return { kind: "terminal-result", text: "terminal" };
            }
          } catch { /* Coordinator may still be resuming. */ }
          return undefined;
        }, "PRODUCT_GRILLING_QUESTION_UNRESOLVED", 420_000);
        if (next.kind !== "action-input-request") throw new Error("PRODUCT_GRILLING_QUESTION_NOT_REQUESTED");
        return next;
      },
      submitOrdinaryAnswer: async (answer) => {
        await submitBrowserCommand(cdp!, answer);
        await waitFor(async () => await evaluate(cdp!,
          `document.body?.innerText?.includes(${JSON.stringify(answer)}) === true`) === true ? true : undefined,
        "PRODUCT_GRILLING_REPLY_NOT_VISIBLE", 40_000);
      },
      submitAgreementAndFinish: async (answer) => {
        const observedBeforeFinish = await events(cdp!);
        const inputBeforeFinish = observedBeforeFinish.filter((event) => event.surface === "chat" && event.kind === "action-input-request").length;
        const terminalBeforeFinish = observedBeforeFinish.filter((event) => event.surface === "chat" && event.kind === "terminal-result").length;
        const statusBeforeFinish = observedBeforeFinish.filter((event) => event.surface === "chat" && event.kind === "delivery-status").length;
        await submitBrowserCommand(cdp!, `/wsr action finish\n${answer}`);
        await waitForKind(cdp!, "delivery-status", statusBeforeFinish, 120_000, "chat");
        afterFinish = await waitFor(async () => {
          const observed = await events(cdp!);
          const input = observed.filter((event) => event.surface === "chat" && event.kind === "action-input-request");
          if (input.length > inputBeforeFinish) return input.at(-1);
          const terminal = observed.filter((event) => event.surface === "chat" && event.kind === "terminal-result");
          if (terminal.length > terminalBeforeFinish) return terminal.at(-1);
          try {
            for (const name of await readdir(activeCoordinatorDirectory)) {
              const coordinator = JSON.parse(await readFile(path.join(activeCoordinatorDirectory, name), "utf8"));
              if (coordinator.phase === "terminal") return { kind: "terminal-result" };
            }
          } catch { /* Coordinator may still be advancing. */ }
          return undefined;
        }, "PRODUCT_ACTION_FINISH_NOT_OBSERVED", 300_000);
      },
    });
    if (afterFinish === undefined) throw new Error("PRODUCT_ACTION_FINISH_NOT_OBSERVED");

    const manifestDirectory = path.join(durable, "state", "manifests");
    if (afterFinish.kind === "terminal-result") {
      const manifestsBeforeRecovery = new Set(await readdir(manifestDirectory));
      const recoveryInputBefore = (await events(cdp)).filter((event) => event.surface === "chat" && event.kind === "action-input-request").length;
      await submitBrowserCommand(cdp, "/wsr create system-design-workflow@0.3.0\nBefore any design work, call workflow_request_input once to ask for a recovery-check detail. Do not call workflow_complete until the external answer is received.");
      activeSystemManifestName = await waitFor(async () => {
        for (const name of await readdir(manifestDirectory)) {
          if (manifestsBeforeRecovery.has(name)) continue;
          const manifest = JSON.parse(await readFile(path.join(manifestDirectory, name), "utf8"));
          if (manifest.resolvedPackage?.name === "system-design-workflow") return name;
        }
        return undefined;
      }, "PRODUCT_RECOVERY_MANIFEST_NOT_CREATED", 120_000);
      await waitForKind(cdp, "action-input-request", recoveryInputBefore, 420_000, "chat");
    }
    const bindingDocumentBefore = JSON.parse(await readFile(bindingFile, "utf8"));
    const bindingBefore = bindingDocumentBefore.bindings?.find((entry: any) => entry.sessionKey === firstSession);
    if (bindingBefore === undefined) throw new Error("PRODUCT_SYSTEM_BINDING_MISSING");
    const manifestNames = await readdir(manifestDirectory);
    let systemManifestPath: string | undefined;
    for (const name of manifestNames) {
      const candidate = path.join(manifestDirectory, name);
      const manifest = JSON.parse(await readFile(candidate, "utf8"));
      if (manifest.deliveryId === bindingBefore.deliveryId && manifest.resolvedPackage?.name === "system-design-workflow") systemManifestPath = candidate;
    }
    if (systemManifestPath === undefined) throw new Error("PRODUCT_SYSTEM_MANIFEST_MISSING");
    const systemManifestBefore = await readFile(systemManifestPath);
    const firstHistory = await rpc(started.url, "session.history", { sessionId: firstSession });
    if (firstHistory.ok !== true) throw new Error("PRODUCT_SESSION_HISTORY_UNAVAILABLE");

    cdp.close();
    cdp = undefined;
    await stop(chrome);
    chrome = undefined;
    await stop(dsh);
    dsh = undefined;
    const restarted = await startDsh(dshHome, worktree);
    dsh = restarted.child;
    const secondBrowser = await launchBrowser(root, restarted.url);
    chrome = secondBrowser.child;
    cdp = secondBrowser.cdp;
    await reopenWorkspace(cdp, restarted.url, workspaceId);
    await observe(cdp);
    await clickWsrTab(cdp, "Current status");
    const recovered = await waitForKind(cdp, "delivery-status", 0, 120_000, "sidebar");
    if (!/delivery|awaiting|running|recovery/i.test(recovered.text)) throw new Error(`PRODUCT_RECOVERY_STATUS_INVALID:${recovered.text}`);
    const bindingDocumentAfter = JSON.parse(await readFile(bindingFile, "utf8"));
    const bindingAfter = bindingDocumentAfter.bindings?.find((entry: any) => entry.sessionKey === firstSession);
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
      empty: Object.freeze({ kind: empty.kind, text: empty.text }),
      hello: Object.freeze({ terminal: helloTerminal.text, kinds: [...new Set(helloEvents.map((event) => event.kind))] }),
      systemDesign: Object.freeze({ inputRequest: firstInput.text, grilling, actionFinishObserved: true }),
      recovery: Object.freeze({ status: recovered.text, manifestIdentityPreserved: true, bindingIdentityPreserved: true }),
      browserEvents: Object.freeze(finalEvents),
    });
  } finally {
    cdp?.close();
    await stop(chrome);
    await stop(dsh);
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [coreArchive, pluginArchive, sourceConfigFile] = process.argv.slice(2);
  if (coreArchive === undefined || pluginArchive === undefined || sourceConfigFile === undefined) {
    throw new TypeError("DSH_PRODUCT_QUALIFICATION_USAGE_INVALID");
  }
  process.stdout.write(`${JSON.stringify(await qualifyDshProductE2e({ coreArchive, pluginArchive, sourceConfigFile }), null, 2)}\n`);
}
