import { canonicalDigest, type ActionInputRequest, type ActionInputResponse, type ActionInteractionBridge, type AdmittedControlResult, type AgentOutputFrame, type ControlBridgeError, type ExternalControlRequest, type FrozenJsonValue, type InteractionError, type Result, type WorkflowControlBridge } from "../contracts/index.js";
import type { TaskPrompt } from "../application/execution-application.js";
import { actionInputRequestPresentation, actionOutputPresentation } from "../intake/presentation.js";
import type { ExecutionBootstrapDependencies } from "./contracts.js";

export interface BrokerDelivery {
  readonly deliveryId: string;
  readonly worktree: string;
  readonly package: string;
  correlation?: string;
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
  constructor(readonly presentation: ExecutionBootstrapDependencies["intake"]) {}

  expect(worktree: string, correlation: string | undefined): void {
    if (correlation !== undefined) this.#correlationByWorktree.set(worktree, correlation);
  }
  attach(deliveryId: string, correlation: string): void {
    this.#correlationByDelivery.set(deliveryId, correlation);
    const delivery = this.#deliveries.get(deliveryId);
    if (delivery !== undefined) delivery.correlation = correlation;
  }
  register(deliveryId: string, worktree: string, packageCoordinate: string): void {
    const correlation = this.#correlationByDelivery.get(deliveryId) ?? this.#correlationByWorktree.get(worktree);
    this.#correlationByWorktree.delete(worktree);
    const delivery: BrokerDelivery = { deliveryId, worktree, package: packageCoordinate, ...(correlation === undefined ? {} : { correlation }) };
    this.#deliveries.set(deliveryId, delivery);
    if (correlation !== undefined) for (const resolve of this.#waiters.get(correlation) ?? []) resolve(delivery);
    if (correlation !== undefined) this.#waiters.delete(correlation);
  }
  bridge(deliveryId: string): ActionInteractionBridge {
    return Object.freeze({
      publish: async (frame: AgentOutputFrame) => {
        const correlation = this.#deliveries.get(deliveryId)?.correlation ?? deliveryId;
        await this.presentation.publish(actionOutputPresentation(correlation, frame.content)).catch(() => undefined);
        return Object.freeze({ ok: true as const, value: undefined });
      },
      requestInput: async (request: ActionInputRequest): Promise<Result<ActionInputResponse, InteractionError>> => new Promise((resolve) => {
        this.#pending.set(deliveryId, Object.freeze({ kind: "action" as const, request, resolve }));
        const correlation = this.#deliveries.get(deliveryId)?.correlation ?? deliveryId;
        void this.presentation.publish(actionInputRequestPresentation(correlation, request.prompt)).catch(() => undefined);
      }),
    });
  }
  workflowBridge(deliveryId: string): WorkflowControlBridge {
    return Object.freeze({
      request: async (request: ExternalControlRequest): Promise<Result<AdmittedControlResult, ControlBridgeError>> => new Promise((resolve) => {
        this.#pending.set(deliveryId, Object.freeze({ kind: "workflow" as const, request, resolve }));
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
  pending(deliveryId: string): boolean { return this.#pending.has(deliveryId); }
  respond(deliveryId: string, kind: ActionInputResponse["kind"], prompt: TaskPrompt): boolean {
    const pending = this.#pending.get(deliveryId);
    if (pending === undefined) return false;
    if (pending.kind === "workflow") {
      if (kind !== "ANSWER" || prompt.attachments.length !== 0) return false;
      let content: FrozenJsonValue;
      try { content = deepFreeze(JSON.parse(prompt.text) as FrozenJsonValue); }
      catch { return false; }
      this.#pending.delete(deliveryId);
      pending.resolve(Object.freeze({ ok: true, value: Object.freeze({
        controlIdentity: pending.request.controlIdentity,
        correlationIdentity: pending.request.correlationIdentity,
        content,
        contentIdentity: canonicalDigest(content),
      }) }));
      return true;
    }
    this.#pending.delete(deliveryId);
    const content = Object.freeze({ text: prompt.text, attachments: prompt.attachments }) as unknown as FrozenJsonValue;
    pending.resolve(Object.freeze({ ok: true, value: Object.freeze({
      kind,
      requestIdentity: pending.request.identity,
      content,
      contentIdentity: canonicalDigest(content),
    }) }));
    return true;
  }
}
