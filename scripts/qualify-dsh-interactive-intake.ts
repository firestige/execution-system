import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ensureDshProfileInstallationPolicy } from "./dsh-profile-installation.js";

const require = createRequire(import.meta.url);
const repository = path.resolve(import.meta.dirname, "..");
const defaultWorktree = path.resolve(repository, "..");

export function dshExecutable(): string {
  const manifestPath = require.resolve("@deepseek-ai/dsh/package.json");
  const manifest = require(manifestPath) as { readonly bin?: { readonly dsh?: string } };
  if (manifest.bin?.dsh === undefined) throw new TypeError("DSH_EXECUTABLE_UNAVAILABLE");
  return path.resolve(path.dirname(manifestPath), manifest.bin.dsh);
}

export function runDsh(dshHome: string, cwd: string, args: readonly string[]): string {
  return execFileSync(process.execPath, [dshExecutable(), ...args], {
    cwd,
    env: { ...process.env, DSH_HOME: dshHome },
    encoding: "utf8",
    stdio: "pipe",
  });
}

export async function waitForWebUrl(child: ChildProcess): Promise<URL> {
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
      reject(new Error(`DSH_WEB_EXITED:${String(code)}:${output.slice(-10_000)}`));
    });
  });
}

export async function rpc(url: URL, method: string, payload: unknown): Promise<any> {
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

export interface CdpConnection {
  readonly events: unknown[];
  call(method: string, params?: Readonly<Record<string, unknown>>): Promise<any>;
  close(): void;
}

export function observeChildTranscript(child: ChildProcess, maxCharacters = 10_000): () => string {
  let transcript = "";
  const append = (chunk: Buffer | string) => {
    transcript = `${transcript}${chunk.toString()}`.slice(-maxCharacters);
  };
  child.stdout?.on("data", append);
  child.stderr?.on("data", append);
  return () => transcript;
}

async function connectCdp(url: string): Promise<CdpConnection> {
  const socket = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener("error", () => reject(new Error("CHROME_CDP_CONNECT_FAILED")), { once: true });
  });
  let sequence = 0;
  const events: unknown[] = [];
  const pending = new Map<number, { resolve(value: unknown): void; reject(cause: unknown): void }>();
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data)) as { readonly id?: number; readonly result?: unknown; readonly error?: unknown };
    if (message.id === undefined) {
      if (events.length >= 100) events.shift();
      events.push(message);
      return;
    }
    const waiter = pending.get(message.id);
    if (waiter === undefined) return;
    pending.delete(message.id);
    if (message.error === undefined) waiter.resolve(message.result);
    else waiter.reject(new Error(`CHROME_CDP_ERROR:${JSON.stringify(message.error)}`));
  });
  return Object.freeze({
    events,
    call(method: string, params: Readonly<Record<string, unknown>> = {}) {
      const id = ++sequence;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        socket.send(JSON.stringify({ id, method, params }));
      });
    },
    close() { socket.close(); },
  });
}

function chromeExecutable(): string {
  if (process.env.WSR_CHROME_PATH !== undefined) return path.resolve(process.env.WSR_CHROME_PATH);
  if (process.platform === "darwin") return "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  return "google-chrome";
}

export async function waitFor<T>(read: () => Promise<T | undefined>, code: string, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(code);
}

export async function launchBrowser(root: string, url: URL): Promise<Readonly<{ child: ChildProcess; cdp: CdpConnection }>> {
  const profile = path.join(root, "chrome-profile");
  await mkdir(profile, { recursive: true });
  // A reused browser profile retains this file after Chrome exits. Remove the
  // stale port before relaunch so readiness cannot resolve to the dead process.
  await rm(path.join(profile, "DevToolsActivePort"), { force: true });
  const child = spawn(chromeExecutable(), [
    "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
    "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank",
  ], { stdio: ["ignore", "pipe", "pipe"] });
  const port = await waitFor(async () => {
    try {
      const [line] = (await readFile(path.join(profile, "DevToolsActivePort"), "utf8")).split("\n");
      return line === undefined || !/^\d+$/u.test(line) ? undefined : Number(line);
    } catch { return undefined; }
  }, "CHROME_DEVTOOLS_PORT_UNAVAILABLE");
  const target = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" });
  if (!target.ok) throw new Error(`CHROME_TARGET_FAILED:${String(target.status)}`);
  const descriptor = await target.json() as { readonly webSocketDebuggerUrl?: string };
  if (descriptor.webSocketDebuggerUrl === undefined) throw new Error("CHROME_TARGET_INVALID");
  const cdp = await connectCdp(descriptor.webSocketDebuggerUrl);
  await Promise.all([cdp.call("Page.enable"), cdp.call("Runtime.enable"), cdp.call("Log.enable")]);
  await cdp.call("Page.navigate", { url: url.href });
  await waitFor(async () => {
    const response = await cdp.call("Runtime.evaluate", { expression: "document.readyState", returnByValue: true }) as any;
    return response.result?.value === "complete" ? true : undefined;
  }, "DSH_BROWSER_PAGE_TIMEOUT");
  return Object.freeze({ child, cdp });
}

export async function evaluate(cdp: CdpConnection, expression: string): Promise<any> {
  const response = await cdp.call("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }) as any;
  if (response.exceptionDetails !== undefined) throw new Error(`DSH_BROWSER_EVALUATION_FAILED:${JSON.stringify(response.exceptionDetails)}`);
  return response.result?.value;
}

export async function captureBrowserReadinessDiagnostic(cdp: CdpConnection): Promise<Readonly<{
  page: unknown;
  cdpEvents: readonly unknown[];
}>> {
  const page = await evaluate(cdp, `(() => {
    const root = document.querySelector('#root');
    return {
      url: location.href,
      readyState: document.readyState,
      bodyText: (document.body?.innerText ?? '').slice(0, 4000),
      root: root === null ? { present: false } : {
        present: true,
        inert: root.hasAttribute('inert'),
        attributes: Object.fromEntries([...root.attributes].map((attribute) => [attribute.name, attribute.value])),
        html: root.innerHTML.slice(0, 4000),
      },
      controls: [...document.querySelectorAll('button,[role="button"],textarea,[contenteditable="true"]')]
        .slice(0, 50)
        .map((element) => ({
          tag: element.tagName,
          text: (element.textContent ?? '').trim().slice(0, 300),
          role: element.getAttribute('role'),
          disabled: element.getAttribute('disabled'),
          ariaDisabled: element.getAttribute('aria-disabled'),
        })),
    };
  })()`);
  return Object.freeze({ page, cdpEvents: Object.freeze(cdp.events.slice(-20)) });
}

export async function dismissBlockingPrompts(cdp: CdpConnection): Promise<void> {
  await waitFor(async () => {
    const ready = await evaluate(cdp, `(() => {
      const button = [...document.querySelectorAll('button')].find((candidate) =>
        /^(继续|Continue|稍后配置|Later|Skip for now)$/u.test(candidate.textContent?.trim() ?? ''));
      if (button) { button.click(); return false; }
      return document.querySelector('#root')?.hasAttribute('inert') === false;
    })()`);
    return ready === true ? true : undefined;
  }, "DSH_BROWSER_BLOCKING_PROMPT_UNAVAILABLE");
}

export async function submitBrowserCommand(cdp: CdpConnection, line: string): Promise<void> {
  await waitFor(async () => await evaluate(cdp, `(() => {
    const input = document.querySelector('textarea,[contenteditable="true"]');
    if (!input) return false;
    if (input instanceof HTMLTextAreaElement && (input.disabled || input.readOnly)) return false;
    if (input instanceof HTMLElement && input.getAttribute('aria-disabled') === 'true') return false;
    input.focus();
    return true;
  })()`) === true ? true : undefined, "DSH_BROWSER_COMPOSER_UNAVAILABLE", 120_000);
  await cdp.call("Input.insertText", { text: line });
  await cdp.call("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
  await cdp.call("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
}

export async function qualifyDshInteractiveIntake(input: Readonly<{
  coreArchive: string;
  pluginArchive: string;
  worktree?: string;
}>): Promise<Readonly<{
  command: string;
  result: "PASS";
  oracle: "browser-dom";
  presentation: Readonly<{ version: string; kind: string; itemCount: number }>;
  errorPresentation: Readonly<{ version: string; kind: string; code: string }>;
  sessionSwitch: "PASS";
}>> {
  const coreArchive = path.resolve(input.coreArchive);
  const pluginArchive = path.resolve(input.pluginArchive);
  const worktree = path.resolve(input.worktree ?? defaultWorktree);
  const root = await mkdtemp(path.join(tmpdir(), "execution-dsh-interactive-"));
  const dshHome = path.join(root, "dsh-home");
  const durable = path.join(root, "durable");
  const configFile = path.join(durable, "execution.json");
  const bindingFile = path.join(durable, "intake-bindings.json");
  let child: ChildProcess | undefined;
  let readDshTranscript: (() => string) | undefined;
  let chrome: ChildProcess | undefined;
  let cdp: CdpConnection | undefined;
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
    await ensureDshProfileInstallationPolicy("web", (args) => runDsh(dshHome, worktree, args));
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
    readDshTranscript = observeChildTranscript(child);
    const webUrl = await waitForWebUrl(child);
    const page = await fetch(webUrl);
    if (page.status !== 200 || !(await page.text()).includes("<div id=\"root\"></div>")) throw new Error("DSH_WEB_PAGE_INVALID");
    const browser = await launchBrowser(root, webUrl);
    chrome = browser.child;
    cdp = browser.cdp;
    await evaluate(cdp, `window.__wsrObservedKinds = []; new MutationObserver(() => {
      for (const element of document.querySelectorAll('[data-wsr-kind]')) {
        const kind = element.getAttribute('data-wsr-kind');
        if (kind && !window.__wsrObservedKinds.includes(kind)) window.__wsrObservedKinds.push(kind);
      }
    }).observe(document.documentElement, { childList: true, subtree: true, attributes: true }); true`);
    try {
      await waitFor(async () => {
        const ready = await evaluate(cdp!, `(() => {
          const button = [...document.querySelectorAll('button')].find((candidate) => /^(继续|Continue|稍后配置|Later|Skip for now)$/u.test(candidate.textContent?.trim() ?? ''));
          if (button) { button.click(); return false; }
          return document.querySelector('#root')?.hasAttribute('inert') === false
            && /选择工作区|Select workspace/u.test(document.body?.innerText ?? '');
        })()`);
        return ready === true ? true : undefined;
      }, "DSH_BROWSER_ONBOARDING_UNAVAILABLE");
    } catch (cause) {
      let browser: unknown;
      try { browser = await captureBrowserReadinessDiagnostic(cdp); }
      catch (diagnosticCause) { browser = { captureError: String(diagnosticCause) }; }
      const diagnostic = JSON.stringify({
        browser,
        dsh: {
          exitCode: child.exitCode,
          signalCode: child.signalCode,
          killed: child.killed,
          transcript: readDshTranscript?.(),
        },
      }).slice(0, 20_000);
      throw new Error(`DSH_BROWSER_ONBOARDING_UNAVAILABLE:${diagnostic}`, { cause });
    }
    const workspaceCreated = await rpc(webUrl, "workspace.create", { path: worktree });
    if (workspaceCreated.ok !== true || typeof workspaceCreated.value?.workspace?.workspaceId !== "string") {
      throw new Error(`DSH_WORKSPACE_CREATE_FAILED:${JSON.stringify(workspaceCreated)}`);
    }
    await waitFor(async () => {
      const opened = await evaluate(cdp!, `(() => {
        const button = [...document.querySelectorAll('button')].find((candidate) => /^(选择工作区|Select workspace)$/u.test(candidate.textContent?.trim() ?? ''));
        if (!button) return false;
        button.click();
        return true;
      })()`);
      return opened === true ? true : undefined;
    }, "DSH_BROWSER_WORKSPACE_PICKER_UNAVAILABLE");
    const workspaceTitle = workspaceCreated.value.workspace.title as string;
    try {
      await waitFor(async () => {
        const selected = await evaluate(cdp!, `(() => {
          const title = ${JSON.stringify(workspaceTitle)};
          const candidate = [...document.querySelectorAll('button,[role="button"]')].find((element) =>
            (element.textContent?.trim() ?? '').includes(title) && !/^(选择工作区|Select workspace)$/u.test(element.textContent?.trim() ?? ''));
          if (!candidate) return false;
          candidate.click();
          return true;
        })()`);
        return selected === true ? true : undefined;
      }, "DSH_BROWSER_WORKSPACE_OPTION_UNAVAILABLE");
    } catch (cause) {
      const diagnostic = await evaluate(cdp, `({ text: document.body?.innerText, controls: [...document.querySelectorAll('button,[role="button"]')].map((element) => element.textContent?.trim()).filter(Boolean) })`);
      throw new Error(`DSH_BROWSER_WORKSPACE_OPTION_UNAVAILABLE:${JSON.stringify(diagnostic)}`, { cause });
    }
    await waitFor(async () => await evaluate(cdp!, `document.body?.innerText?.includes(${JSON.stringify(workspaceTitle)}) === true`) === true ? true : undefined,
      "DSH_BROWSER_WORKSPACE_SELECTION_FAILED");
    await dismissBlockingPrompts(cdp);
    const sessionId = await waitFor(async () => {
      const listed = await rpc(webUrl, "workspace.list", {});
      const selected = listed.value?.items?.find((entry: any) => entry.workspaceId === workspaceCreated.value.workspace.workspaceId);
      const id = selected?.sessionIds?.at(-1);
      return listed.ok === true && typeof id === "string" ? id : undefined;
    }, "DSH_BROWSER_SESSION_CREATE_FAILED");
    const catalog = await rpc(webUrl, "commands/list", { args: { agentId: sessionId } });
    if (catalog.ok !== true || !catalog.value?.some((entry: any) => entry.name === "wsr")) throw new Error("DSH_WSR_COMMAND_MISSING");
    await waitFor(async () => await evaluate(cdp!, `(() => {
      const button = [...document.querySelectorAll('[data-wsr-sidebar="true"] button')]
        .find((candidate) => candidate.textContent?.trim() === 'Deliveries');
      if (!button) return false;
      button.click();
      return true;
    })()`) === true ? true : undefined, "DSH_WSR_LIST_TAB_UNAVAILABLE");
    const history = await waitFor(async () => {
      const candidate = await rpc(webUrl, "session.history", { sessionId });
      const commandEvents = candidate.value?.events?.filter((entry: any) => entry.event.type.startsWith("command/"));
      return candidate.ok === true && commandEvents?.length === 2 ? candidate : undefined;
    }, "DSH_WSR_COMMAND_FAILED", 40_000);
    const events = history.value.events.filter((entry: any) => entry.event.type.startsWith("command/"));
    let commandPresentation: any;
    try { commandPresentation = JSON.parse(events[1]?.event?.data?.text); } catch { /* checked below */ }
    if (JSON.stringify(events.map((entry: any) => entry.event.type)) !== JSON.stringify(["command/run", "command/done"])
      || commandPresentation?.schemaVersion !== "wsr.presentation@1.0.0"
      || commandPresentation?.kind !== "delivery-list" || !Array.isArray(commandPresentation?.data?.items)) {
      throw new Error(`DSH_WSR_RESULT_NOT_DURABLE:${JSON.stringify(events)}`);
    }
    let presentation: any;
    try {
      presentation = await waitFor(async () => {
        const value = await evaluate(cdp!, `(() => {
          const element = [...document.querySelectorAll('[data-wsr-presentation="true"]')].at(-1);
          if (!element) return null;
          return {
            version: element.getAttribute('data-wsr-version'),
            kind: element.getAttribute('data-wsr-kind'),
            text: element.textContent,
            observedKinds: window.__wsrObservedKinds,
          };
        })()`);
        if (value?.version !== "wsr.presentation@1.0.0" || value?.kind !== "delivery-list"
          || typeof value?.text !== "string" || !value.text.includes("No Workflow Deliveries")) return undefined;
        return value;
      }, "DSH_WSR_BROWSER_PRESENTATION_MISSING");
    } catch (cause) {
      const diagnostic = await evaluate(cdp, `({
        location: location.href,
        text: document.body?.innerText?.slice(0, 4000),
        html: document.body?.innerHTML?.slice(0, 4000),
        observedKinds: window.__wsrObservedKinds,
        pluginResources: performance.getEntriesByType('resource').map((entry) => entry.name).filter((name) => name.includes('/plugins/')),
      })`);
      throw new Error(`DSH_WSR_BROWSER_PRESENTATION_MISSING:${JSON.stringify({ ...diagnostic, durableEvents: events, cdpEvents: cdp.events.slice(-20) })}`, { cause });
    }
    if (!presentation.observedKinds.includes("delivery-list")) {
      throw new Error(`DSH_WSR_BROWSER_LIFECYCLE_MISSING:${JSON.stringify(presentation.observedKinds)}`);
    }
    await waitFor(async () => await evaluate(cdp!, `(() => {
      const button = [...document.querySelectorAll('[data-wsr-sidebar="true"] button')]
        .find((candidate) => candidate.textContent?.trim() === 'Current status');
      if (!button) return false;
      button.click();
      return true;
    })()`) === true ? true : undefined, "DSH_WSR_STATUS_TAB_UNAVAILABLE");
    const errorHistory = await waitFor(async () => {
      const candidate = await rpc(webUrl, "session.history", { sessionId });
      const commandEvents = candidate.value?.events?.filter((entry: any) => entry.event.type.startsWith("command/"));
      return candidate.ok === true && commandEvents?.length === 4 ? candidate : undefined;
    }, "DSH_WSR_ERROR_COMMAND_FAILED", 40_000);
    const errorDone = errorHistory.value.events.filter((entry: any) => entry.event.type === "command/done").at(-1);
    let errorEnvelope: any;
    try { errorEnvelope = JSON.parse(errorDone?.event?.data?.text); } catch { /* checked below */ }
    if (errorEnvelope?.schemaVersion !== "wsr.presentation@1.0.0" || errorEnvelope?.kind !== "error"
      || errorEnvelope?.data?.code !== "DELIVERY_UNKNOWN") throw new Error("DSH_WSR_ERROR_NOT_DURABLE");
    const errorPresentation = await waitFor(async () => {
      const value = await evaluate(cdp!, `(() => {
        const element = [...document.querySelectorAll('[data-wsr-sidebar="true"][data-wsr-presentation="true"]')].at(-1);
        if (!element) return null;
        return { version: element.getAttribute('data-wsr-version'), kind: element.getAttribute('data-wsr-kind'), text: element.textContent };
      })()`);
      return value?.version === "wsr.presentation@1.0.0" && value?.kind === "error"
        && typeof value?.text === "string" && value.text.includes("DELIVERY_UNKNOWN") ? value : undefined;
    }, "DSH_WSR_BROWSER_ERROR_PRESENTATION_MISSING");
    const alternateWorktree = path.join(root, "alternate-worktree");
    await mkdir(alternateWorktree);
    const alternateWorkspace = await rpc(webUrl, "workspace.create", { path: alternateWorktree });
    if (alternateWorkspace.ok !== true || typeof alternateWorkspace.value?.workspace?.workspaceId !== "string") {
      throw new Error("DSH_ALTERNATE_WORKSPACE_CREATE_FAILED");
    }
    const alternateWorkspaceTitle = alternateWorkspace.value.workspace.title as string;
    await cdp.call("Page.reload", { ignoreCache: true });
    await waitFor(async () => {
      const response = await cdp!.call("Runtime.evaluate", { expression: "document.readyState", returnByValue: true }) as any;
      return response.result?.value === "complete" ? true : undefined;
    }, "DSH_BROWSER_SESSION_SWITCH_RELOAD_TIMEOUT");
    await dismissBlockingPrompts(cdp);
    await waitFor(async () => await evaluate(cdp!, `document.querySelector('[data-wsr-sidebar="true"][data-wsr-presentation="true"]')?.getAttribute('data-wsr-kind') === 'error'`) === true ? true : undefined,
      "DSH_WSR_SIDEBAR_DURABLE_RESTORE_FAILED");
    try {
      await waitFor(async () => {
        const opened = await evaluate(cdp!, `(() => {
          const button = [...document.querySelectorAll('button')].find((candidate) => /^(打开侧边栏|Open sidebar)$/u.test(candidate.getAttribute('aria-label') ?? ''));
          if (button) button.click();
          const alternateTitle = ${JSON.stringify(alternateWorkspaceTitle)};
          const createSession = [...document.querySelectorAll('button')].find((candidate) => {
            const label = candidate.getAttribute('aria-label') ?? '';
            return label.includes(alternateTitle) && /新建会话|New session/u.test(label);
          });
          if (!createSession) return false;
          createSession.click();
          return true;
        })()`);
        return opened === true ? true : undefined;
      }, "DSH_BROWSER_SESSION_ROWS_UNAVAILABLE");
    } catch (cause) {
      const rows = await evaluate(cdp, `[...document.querySelectorAll('[role="treeitem"],button')].map((element) => ({ text: element.textContent?.trim(), selected: element.getAttribute('aria-selected'), label: element.getAttribute('aria-label') })).filter((entry) => entry.text || entry.label)`);
      throw new Error(`DSH_BROWSER_SESSION_ROWS_UNAVAILABLE:${JSON.stringify(rows)}`, { cause });
    }
    await waitFor(async () => await evaluate(cdp!, `document.querySelector('[data-wsr-sidebar="true"]')?.getAttribute('data-wsr-kind') === 'idle'`) === true ? true : undefined,
      "DSH_WSR_SIDEBAR_SESSION_CLEAR_FAILED");
    return Object.freeze({
      command: "/wsr list",
      result: "PASS" as const,
      oracle: "browser-dom" as const,
      presentation: Object.freeze({ version: presentation.version, kind: presentation.kind, itemCount: 0 }),
      errorPresentation: Object.freeze({ version: errorPresentation.version, kind: errorPresentation.kind, code: "DELIVERY_UNKNOWN" }),
      sessionSwitch: "PASS" as const,
    });
  } finally {
    cdp?.close();
    if (chrome !== undefined && chrome.exitCode === null) {
      chrome.kill("SIGTERM");
      await new Promise<void>((resolve) => chrome!.once("exit", () => resolve()));
    }
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
