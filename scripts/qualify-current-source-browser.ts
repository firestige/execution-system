#!/usr/bin/env node
import type { ChildProcess } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  dismissBlockingPrompts,
  evaluate,
  launchBrowser,
  rpc,
  submitBrowserCommand,
  waitFor,
  type CdpConnection,
} from "./qualify-dsh-interactive-intake.js";
import { parseCurrentSourceBrowserQualificationArguments } from "./current-source-browser-qualification.js";

async function selectWorkspace(cdp: CdpConnection, origin: URL, workspace: string): Promise<string> {
  const created = await rpc(origin, "workspace.create", { path: workspace });
  const workspaceId = created.value?.workspace?.workspaceId;
  const title = created.value?.workspace?.title;
  if (created.ok !== true || typeof workspaceId !== "string" || typeof title !== "string") {
    throw new Error("CURRENT_SOURCE_WORKSPACE_REGISTRATION_FAILED");
  }
  await dismissBlockingPrompts(cdp);
  const state = await waitFor(async () => {
    const value = await evaluate(cdp, `(() => {
      if ([...document.querySelectorAll('button')].some((button) => /^(选择工作区|Choose workspace|Select workspace)$/u.test(button.textContent?.trim() ?? ''))) return 'picker';
      if (document.querySelector('[data-wsr-sidebar-resources="true"]') || document.querySelector('textarea,[contenteditable="true"]')) return 'active';
      return undefined;
    })()`);
    return value === "picker" || value === "active" ? value : undefined;
  }, "CURRENT_SOURCE_WORKSPACE_PICKER_UNAVAILABLE", 40_000);
  if (state === "picker") {
    await waitFor(async () => await evaluate(cdp, `(() => {
      const button = [...document.querySelectorAll('button')].find((candidate) => /^(选择工作区|Choose workspace|Select workspace)$/u.test(candidate.textContent?.trim() ?? ''));
      if (!button) return false;
      button.click();
      return true;
    })()`) === true ? true : undefined, "CURRENT_SOURCE_WORKSPACE_PICKER_UNAVAILABLE", 40_000);
    await waitFor(async () => await evaluate(cdp, `(() => {
      const title = ${JSON.stringify(title)};
      const candidate = [...document.querySelectorAll('button,[role="button"]')].find((element) =>
        (element.textContent?.trim() ?? '').includes(title) && !/^(选择工作区|Choose workspace|Select workspace)$/u.test(element.textContent?.trim() ?? ''));
      if (!candidate) return false;
      candidate.click();
      return true;
    })()`) === true ? true : undefined, "CURRENT_SOURCE_WORKSPACE_OPTION_UNAVAILABLE", 40_000);
  }
  await dismissBlockingPrompts(cdp);
  await waitFor(async () => await evaluate(cdp, `(() => {
    const input = [...document.querySelectorAll('textarea,[contenteditable="true"]')].find((candidate) => {
      if (!(candidate instanceof HTMLElement) || candidate.getClientRects().length === 0) return false;
      return candidate.getAttribute('aria-disabled') !== 'true';
    });
    return input && (document.body?.innerText ?? '').includes(${JSON.stringify(title)}) ? true : undefined;
  })()`), "CURRENT_SOURCE_WORKSPACE_NOT_SELECTED", 40_000);
  return workspaceId;
}

async function tasks(evidence: URL): Promise<any[]> {
  const response = await fetch(new URL("/v1/evidence/tasks?limit=100", evidence));
  if (!response.ok) throw new Error(`CURRENT_SOURCE_EVIDENCE_TASKS_HTTP_${String(response.status)}`);
  const document = await response.json() as any;
  if (!Array.isArray(document.items)) throw new Error("CURRENT_SOURCE_EVIDENCE_TASKS_INVALID");
  return document.items;
}

async function main(): Promise<void> {
  const arguments_ = process.argv.slice(2);
  const [originValue, workspaceValue, evidenceValue] = arguments_;
  if (originValue === undefined || workspaceValue === undefined || evidenceValue === undefined) {
    throw new Error("usage: qualify-current-source-browser ORIGIN WORKSPACE EVIDENCE_ORIGIN evidence-studio EXACT_SELECTOR | ORIGIN WORKSPACE EVIDENCE_ORIGIN diagnostic");
  }
  const qualification = parseCurrentSourceBrowserQualificationArguments(process.argv.slice(2));
  const origin = new URL(originValue);
  const evidence = new URL(evidenceValue);
  const workspace = await realpath(workspaceValue);
  const temporary = await mkdtemp(path.join(tmpdir(), "wsr-current-source-browser-"));
  let chrome: ChildProcess | undefined;
  let cdp: CdpConnection | undefined;
  try {
    const beforeTasks = new Set((await tasks(evidence)).map((item) => item.task_id));
    const browser = await launchBrowser(temporary, origin);
    chrome = browser.child;
    cdp = browser.cdp;
    const workspaceId = await selectWorkspace(cdp, origin, workspace);
    if (qualification.scenario === "diagnostic") {
      await submitBrowserCommand(cdp, "/wsr create system-design-workflow\nDesign a local health endpoint and preserve a controlled lower-layer failure diagnostic.");
      const first = await waitFor(async () => await evaluate(cdp!, `(() => {
        const nodes = [...document.querySelectorAll('[data-wsr-presentation="true"][data-wsr-surface="chat"][data-wsr-state="unresolved"]')];
        for (const node of nodes) {
          const row = node.closest('[data-disclosure-row="true"]');
          if (row?.getAttribute('aria-expanded') === 'false') row.click();
        }
        const bodies = [...document.querySelectorAll('[data-wsr-presentation-body="true"][data-wsr-state="unresolved"]')];
        const body = bodies.findLast((candidate) => candidate.textContent?.includes('HOST_START') && candidate.textContent?.includes('DATAFLOW_BINDING_INVALID'));
        const node = body === undefined ? undefined : nodes.findLast((candidate) => candidate.closest('[data-disclosure-row="true"]')?.parentElement?.contains(body));
        return node && body
          ? { count: nodes.length, text: node.textContent + ' · ' + body.textContent }
          : undefined;
      })()`), "CURRENT_SOURCE_PUBLIC_DIAGNOSTIC_UNAVAILABLE", 360_000);
      await submitBrowserCommand(cdp, "/wsr status");
      const status = await waitFor(async () => await evaluate(cdp!, `(() => {
        const nodes = [...document.querySelectorAll('[data-wsr-presentation="true"][data-wsr-surface="chat"][data-wsr-state="unresolved"]')];
        if (nodes.length <= ${JSON.stringify(first.count)}) return undefined;
        const node = nodes.at(-1);
        const row = node?.closest('[data-disclosure-row="true"]');
        if (row?.getAttribute('aria-expanded') === 'false') row.click();
        const bodies = [...document.querySelectorAll('[data-wsr-presentation-body="true"][data-wsr-state="unresolved"]')];
        const body = row?.parentElement?.querySelector('[data-wsr-presentation-body="true"][data-wsr-state="unresolved"]');
        return node && body
          && body.textContent?.includes('HOST_START') && body.textContent?.includes('DATAFLOW_BINDING_INVALID')
          ? { count: nodes.length, text: node.textContent + ' · ' + body.textContent }
          : undefined;
      })()`), "CURRENT_SOURCE_STATUS_DIAGNOSTIC_UNAVAILABLE", 60_000);
      const sidebar = await waitFor(async () => await evaluate(cdp!, `(() => {
        const row = [...document.querySelectorAll('.wsr-delivery-row')].find((node) => /Result unresolved/iu.test(node.getAttribute('aria-label') ?? ''));
        return row ? { label: row.getAttribute('aria-label') } : undefined;
      })()`), "CURRENT_SOURCE_SIDEBAR_UNRESOLVED_UNAVAILABLE", 40_000);
      process.stdout.write(`${JSON.stringify({
        result: "PASS", evidenceKind: qualification.evidenceKind,
        diagnosticSelector: qualification.diagnosticSelector ?? null,
        oracle: "browser-dom-controlled-failure", workspaceId,
        diagnostic: { stage: "HOST_START", causeCode: "DATAFLOW_BINDING_INVALID", initial: first.text, status: status.text },
        convergence: { chat: "unresolved", sidebar: sidebar.label, tag: "unresolved" },
      })}\n`);
      return;
    }
    await submitBrowserCommand(cdp, `/wsr create ${qualification.workflowSelector}\nGreet the current-source Product qualification and return a concise final answer.`);
    const terminal = await waitFor(async () => await evaluate(cdp!, `(() => {
      const candidates = [...document.querySelectorAll('[data-wsr-presentation="true"][data-wsr-surface="chat"]')];
      const error = candidates.findLast((node) => node.getAttribute('data-wsr-kind') === 'error');
      if (error) return { kind: 'error', text: error.textContent };
      const result = candidates.findLast((node) => node.getAttribute('data-wsr-kind') === 'terminal-result');
      return result ? { kind: 'terminal-result', text: result.textContent } : undefined;
    })()`), "CURRENT_SOURCE_DELIVERY_TERMINAL_UNAVAILABLE", 360_000);
    if (terminal.kind !== "terminal-result") {
      throw new Error(`CURRENT_SOURCE_DELIVERY_FAILED:${JSON.stringify(terminal)}`);
    }
    const task = await waitFor(async () => {
      const added = (await tasks(evidence)).filter((item) => typeof item.task_id === "string" && !beforeTasks.has(item.task_id));
      return added.length === 1 ? added[0] : undefined;
    }, "CURRENT_SOURCE_TASK_BINDING_NOT_PROJECTED", 60_000);
    await waitFor(async () => await evaluate(cdp!, `(() => {
      const tab = [...document.querySelectorAll('[role="tab"]')].find((node) => node.textContent?.trim() === 'WSR Studio');
      if (!tab) return false;
      tab.click();
      return true;
    })()`) === true ? true : undefined, "CURRENT_SOURCE_STUDIO_TAB_UNAVAILABLE", 40_000);
    await waitFor(async () => await evaluate(cdp!, `document.querySelector('[data-wsr-studio-page="selection"]') ? true : undefined`), "CURRENT_SOURCE_STUDIO_SELECTION_UNAVAILABLE", 40_000);
    await evaluate(cdp, `(() => {
      const button = [...document.querySelectorAll('button')].find((node) => node.textContent?.trim() === 'Load tasks');
      if (!button) throw new Error('load tasks unavailable');
      button.click();
    })()`);
    await waitFor(async () => await evaluate(cdp!, `(() => {
      const row = document.querySelector('[data-wsr-task-id=${JSON.stringify(task.task_id)}]');
      const input = row?.querySelector('input[type="checkbox"]');
      if (!input) return undefined;
      input.click();
      return true;
    })()`), "CURRENT_SOURCE_STUDIO_TASK_NOT_LOADED", 60_000);
    await evaluate(cdp, `(() => {
      const button = [...document.querySelectorAll('button')].find((node) => node.textContent?.trim() === 'Evaluate selection');
      if (!button || button.disabled) throw new Error('evaluate selection unavailable');
      button.click();
    })()`);
    const dashboard = await waitFor(async () => await evaluate(cdp!, `(() => {
      const layout = document.querySelector('[data-wsr-dashboard-layout="wsr-dsh.studio-layout@1"]');
      const receipt = [...document.querySelectorAll('button')].find((node) => node.textContent?.trim() === 'View receipt');
      if (!layout || !receipt) return undefined;
      return { panels: layout.querySelectorAll('[data-wsr-dashboard-panel]').length, receipt: true };
    })()`), "CURRENT_SOURCE_STUDIO_EVALUATE_FAILED", 120_000);
    if (dashboard.panels < 1) throw new Error(`CURRENT_SOURCE_STUDIO_DASHBOARD_EMPTY:${JSON.stringify(dashboard)}`);
    await evaluate(cdp, `([...document.querySelectorAll('button')].find((node) => node.textContent?.trim() === 'View receipt')).click()`);
    await waitFor(async () => await evaluate(cdp!, `(document.body?.innerText ?? '').includes('/v1/evidence/facts') ? true : undefined`), "CURRENT_SOURCE_STUDIO_RECEIPT_UNAVAILABLE", 40_000);
    process.stdout.write(`${JSON.stringify({
      result: "PASS",
      evidenceKind: qualification.evidenceKind,
      workflowSelector: qualification.workflowSelector,
      oracle: "browser-dom-and-real-services",
      workspaceId,
      task: { taskId: task.task_id, displayName: task.display_name ?? null },
      evidence: { origin: evidence.origin, projected: true },
      studio: { loaded: true, evaluated: true, panels: dashboard.panels, receipt: true },
    })}\n`);
  } finally {
    cdp?.close();
    if (chrome !== undefined && chrome.exitCode === null) {
      chrome.kill("SIGTERM");
      await new Promise<void>((resolve) => chrome!.once("exit", () => resolve()));
    }
    await rm(temporary, { recursive: true, force: true });
  }
}

void main().catch((cause) => {
  process.stderr.write(`${cause instanceof Error ? cause.stack ?? cause.message : String(cause)}\n`);
  process.exitCode = 1;
});
