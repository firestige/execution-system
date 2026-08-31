import { canonicalDigest, type ActionInputRequest, type ActionInputResponse, type ActionInteractionBridge, type AdmittedControlResult, type AgentOutputFrame, type ControlBridgeError, type ExternalControlRequest, type FrozenJsonValue, type InteractionError, type Result, type WorkflowControlBridge } from "../contracts/index.js";
import type { TaskPrompt } from "../application/execution-application.js";
import { actionInputRequestPresentation, actionOutputPresentation } from "../intake/presentation.js";
import type { ExecutionBootstrapDependencies } from "./contracts.js";
import type { DeliveryProjectionBinding, DeliveryProjectionRuntime } from "../delivery/control-plane-projection.js";

export interface BrokerDelivery {
  readonly deliveryId: string;
  readonly worktree: string;
  readonly package: string;
  readonly deliveryBindingIdentity: string;
  correlation?: string;
  readonly actionBySite?: Readonly<Record<string, string>>;
  readonly finalActionSites?: readonly string[];
  finalOutput?: string;
}

type PendingInteraction =
  | Readonly<{ kind: "action"; request: ActionInputRequest; resolve(response: Result<ActionInputResponse, InteractionError>): void }>
  | Readonly<{ kind: "workflow"; request: ExternalControlRequest; resolve(response: Result<AdmittedControlResult, ControlBridgeError>): void }>;

function deepFreeze<T>(value: T, seen = new Set<object>()): T {
  if (value === null || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

export class ProductionInteractionBroker {
  readonly #deliveries = new Map<string, BrokerDelivery>();
  readonly #correlationByWorktree = new Map<string, string>();
  readonly #correlationByDelivery = new Map<string, string>();
  readonly #waiters = new Map<string, Array<(delivery: BrokerDelivery) => void>>();
  readonly #pending = new Map<string, PendingInteraction>();
  readonly #activeActions = new Map<string, Map<string, number>>();
  constructor(readonly presentation: ExecutionBootstrapDependencies["intake"], readonly invalidate: () => void = () => undefined) {}

  expect(worktree: string, correlation: string | undefined): void {
    if (correlation !== undefined) this.#correlationByWorktree.set(worktree, correlation);
  }
  attach(deliveryId: string, correlation: string): void {
    this.#correlationByDelivery.set(deliveryId, correlation);
    const delivery = this.#deliveries.get(deliveryId);
    if (delivery !== undefined) delivery.correlation = correlation;
    this.invalidate();
  }
  register(deliveryId: string, worktree: string, packageCoordinate: string, deliveryBindingIdentity: string, actionBySite?: Readonly<Record<string, string>>, finalActionSites?: readonly string[]): void {
    const correlation = this.#correlationByDelivery.get(deliveryId) ?? this.#correlationByWorktree.get(worktree);
    this.#correlationByWorktree.delete(worktree);
    const delivery: BrokerDelivery = { deliveryId, worktree, package: packageCoordinate, deliveryBindingIdentity, ...(correlation === undefined ? {} : { correlation }), ...(actionBySite === undefined ? {} : { actionBySite }), ...(finalActionSites === undefined ? {} : { finalActionSites }) };
    this.#deliveries.set(deliveryId, delivery);
    if (correlation !== undefined) for (const resolve of this.#waiters.get(correlation) ?? []) resolve(delivery);
    if (correlation !== undefined) this.#waiters.delete(correlation);
    this.invalidate();
  }
  bridge(deliveryId: string): ActionInteractionBridge {
    return Object.freeze({
      publish: async (frame: AgentOutputFrame) => {
        const delivery = this.#deliveries.get(deliveryId);
        const correlation = delivery?.correlation ?? deliveryId;
        const site = frame.episode.site;
        const siteKey = site.kind === "node" ? `node:${site.nodeIdentity}`
          : site.kind === "parallel-branch" ? `parallel-branch:${site.nodeIdentity}:${site.branchIdentity}`
            : `parallel-join:${site.nodeIdentity}`;
        const presentation = actionOutputPresentation(correlation, frame.content, delivery?.actionBySite?.[siteKey]);
        if (delivery?.finalActionSites?.includes(siteKey)) {
          const content = presentation.data.content;
          if (content !== null && typeof content === "object" && !Array.isArray(content)
            && typeof (content as Readonly<Record<string, FrozenJsonValue>>).text === "string") {
            delivery.finalOutput = (content as Readonly<Record<string, FrozenJsonValue>>).text as string;
          }
        } else {
          await this.presentation.publish(presentation).catch(() => undefined);
        }
        return Object.freeze({ ok: true as const, value: undefined });
      },
      requestInput: async (request: ActionInputRequest): Promise<Result<ActionInputResponse, InteractionError>> => new Promise((resolve) => {
        this.#pending.set(deliveryId, Object.freeze({ kind: "action" as const, request, resolve }));
        this.invalidate();
        const correlation = this.#deliveries.get(deliveryId)?.correlation ?? deliveryId;
        void this.presentation.publish(actionInputRequestPresentation(correlation, request.prompt)).catch(() => undefined);
      }),
    });
  }
  workflowBridge(deliveryId: string): WorkflowControlBridge {
    return Object.freeze({
      request: async (request: ExternalControlRequest): Promise<Result<AdmittedControlResult, ControlBridgeError>> => new Promise((resolve) => {
        this.#pending.set(deliveryId, Object.freeze({ kind: "workflow" as const, request, resolve }));
        this.invalidate();
        const correlation = this.#deliveries.get(deliveryId)?.correlation ?? deliveryId;
        void this.presentation.publish(actionInputRequestPresentation(correlation, request.content)).catch(() => undefined);
      }),
    });
  }
  async waitForDelivery(correlation: string, timeoutMs: number): Promise<BrokerDelivery | undefined> {
    const existing = [...this.#deliveries.values()].find((delivery) => delivery.correlation === correlation);
    if (existing !== undefined) return existing;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        const current = this.#waiters.get(correlation) ?? [];
        const remaining = current.filter((candidate) => candidate !== accept);
        if (remaining.length === 0) this.#waiters.delete(correlation);
        else this.#waiters.set(correlation, remaining);
        resolve(undefined);
      }, timeoutMs);
      const waiting = this.#waiters.get(correlation) ?? [];
      const accept = (delivery: BrokerDelivery) => { clearTimeout(timer); resolve(delivery); };
      waiting.push(accept);
      this.#waiters.set(correlation, waiting);
    });
  }
  deliveryForCorrelation(correlation: string): BrokerDelivery | undefined {
    return [...this.#deliveries.values()].find((delivery) => delivery.correlation === correlation);
  }
  isBound(deliveryId: string): boolean { return this.#deliveries.get(deliveryId)?.correlation !== undefined; }
  bindingForDelivery(deliveryId: string): string | undefined { return this.#deliveries.get(deliveryId)?.correlation; }
  finalOutput(deliveryId: string): string | undefined { return this.#deliveries.get(deliveryId)?.finalOutput; }
  pending(deliveryId: string): boolean { return this.#pending.has(deliveryId); }
  beginAction(deliveryId: string, actionIdentity: string): void {
    if (!this.#deliveries.has(deliveryId) || actionIdentity.length === 0) return;
    const actions = this.#activeActions.get(deliveryId) ?? new Map<string, number>();
    actions.set(actionIdentity, (actions.get(actionIdentity) ?? 0) + 1);
    this.#activeActions.set(deliveryId, actions);
    this.invalidate();
  }
  endAction(deliveryId: string, actionIdentity: string): void {
    const actions = this.#activeActions.get(deliveryId);
    const count = actions?.get(actionIdentity);
    if (actions === undefined || count === undefined) return;
    if (count === 1) actions.delete(actionIdentity); else actions.set(actionIdentity, count - 1);
    if (actions.size === 0) this.#activeActions.delete(deliveryId);
    this.invalidate();
  }
  trackAction(request: Readonly<{ deliveryId: string; actionIdentity?: string; site?: ActionInputRequest["episode"]["site"] }>): () => void {
    const delivery = this.#deliveries.get(request.deliveryId);
    const site = request.site;
    const key = site === undefined ? undefined : site.kind === "node" ? `node:${site.nodeIdentity}`
      : site.kind === "parallel-branch" ? `parallel-branch:${site.nodeIdentity}:${site.branchIdentity}`
        : `parallel-join:${site.nodeIdentity}`;
    const identity = request.actionIdentity ?? (key === undefined ? undefined : delivery?.actionBySite?.[key]);
    if (identity === undefined) return () => undefined;
    this.beginAction(request.deliveryId, identity);
    let ended = false;
    return () => { if (!ended) { ended = true; this.endAction(request.deliveryId, identity); } };
  }
  enumerateBindings(): readonly DeliveryProjectionBinding[] {
    return Object.freeze([...this.#deliveries.values()].map((delivery) => Object.freeze({
      deliveryId: delivery.deliveryId,
      deliveryBindingIdentity: delivery.deliveryBindingIdentity,
      ...(delivery.correlation === undefined ? {} : { sessionCorrelation: delivery.correlation }),
    })));
  }
  enumerateRuntime(): readonly DeliveryProjectionRuntime[] {
    return Object.freeze([...this.#deliveries.values()].map((delivery) => {
      const pending = this.#pending.get(delivery.deliveryId);
      let current: DeliveryProjectionRuntime["current"] = null;
      const active = [...(this.#activeActions.get(delivery.deliveryId)?.keys() ?? [])].sort();
      if (active[0] !== undefined) current = Object.freeze({ kind: "ACTION", identity: active[0] });
      if (pending?.kind === "workflow") current = Object.freeze({ kind: "INTERVENTION", identity: pending.request.controlIdentity });
      if (pending?.kind === "action") {
        const site = pending.request.episode.site;
        const key = site.kind === "node" ? `node:${site.nodeIdentity}`
          : site.kind === "parallel-branch" ? `parallel-branch:${site.nodeIdentity}:${site.branchIdentity}`
            : `parallel-join:${site.nodeIdentity}`;
        const identity = delivery.actionBySite?.[key];
        if (identity !== undefined) current = Object.freeze({ kind: "ACTION", identity });
      }
      return Object.freeze({ deliveryId: delivery.deliveryId, deliveryBindingIdentity: delivery.deliveryBindingIdentity, current, terminal: null, error: null });
    }));
  }
  respond(deliveryId: string, kind: ActionInputResponse["kind"], prompt: TaskPrompt): boolean {
    const pending = this.#pending.get(deliveryId);
    if (pending === undefined) return false;
    if (pending.kind === "workflow") {
      if (kind !== "ANSWER" || prompt.attachments.length !== 0) return false;
      let content: FrozenJsonValue;
      try { content = deepFreeze(JSON.parse(prompt.text) as FrozenJsonValue); }
      catch { return false; }
      this.#pending.delete(deliveryId);
      this.invalidate();
      pending.resolve(Object.freeze({ ok: true, value: Object.freeze({
        controlIdentity: pending.request.controlIdentity,
        correlationIdentity: pending.request.correlationIdentity,
        content,
        contentIdentity: canonicalDigest(content),
      }) }));
      return true;
    }
    this.#pending.delete(deliveryId);
    this.invalidate();
    const content = pending.request.responseSchema.type === "string" && prompt.attachments.length === 0
      ? prompt.text
      : Object.freeze({ text: prompt.text, attachments: prompt.attachments }) as unknown as FrozenJsonValue;
    pending.resolve(Object.freeze({ ok: true, value: Object.freeze({
      kind,
      requestIdentity: pending.request.identity,
      content,
      contentIdentity: canonicalDigest(content),
    }) }));
    return true;
  }
}
