import {
  canonicalDigest,
  type ExecutionSiteRef,
  type FrozenJsonValue,
  type RunnerActivationContext,
} from "../../../src/contracts/index.js";
import type { HostOperationHandler } from "../../../src/host/workflow-host-adapter-factory.js";

export interface ValidationActionExpectation {
  readonly validatorIdentity: string;
  readonly actionIdentity: string;
  readonly site: ExecutionSiteRef;
}

export interface ValidationActionRequest extends ValidationActionExpectation {
  readonly correlation: RunnerActivationContext["correlation"];
  readonly input: FrozenJsonValue;
}

export type ValidationActionDisposition =
  | { readonly kind: "accepted" }
  | { readonly kind: "rejected"; readonly reason: "VALIDATION_ACTION_REJECTED" }
  | { readonly kind: "unavailable"; readonly reason: "VALIDATION_ACTION_UNAVAILABLE" | "VALIDATION_ACTION_MISMATCH" | "VALIDATION_ACTION_DUPLICATE" };

export interface ValidationActionRecord extends ValidationActionRequest {
  readonly disposition: ValidationActionDisposition;
}

export type ValidationActionBehavior = "accepted" | "rejected" | "unavailable" | "throw" | "malformed";

interface ValidationActionAdapterOptions {
  readonly correlation: RunnerActivationContext["correlation"];
  readonly expectations: readonly ValidationActionExpectation[];
  readonly behavior?: ValidationActionBehavior;
}

export class ValidationActionUnavailableError extends Error {
  readonly code = "VALIDATION_ACTION_UNAVAILABLE";

  constructor(readonly disposition: Extract<ValidationActionDisposition, { kind: "unavailable" }>) {
    super(disposition.reason);
    this.name = "ValidationActionUnavailableError";
  }
}

function same(left: unknown, right: unknown): boolean {
  return canonicalDigest(left as FrozenJsonValue) === canonicalDigest(right as FrozenJsonValue);
}

function frozenHandler(execute: HostOperationHandler["execute"]): HostOperationHandler {
  return Object.freeze({ execute });
}

function requestIdentity(request: ValidationActionExpectation): string {
  return canonicalDigest({
    validatorIdentity: request.validatorIdentity,
    actionIdentity: request.actionIdentity,
    site: request.site,
  });
}

export function minimalValidationExpectations(): readonly ValidationActionExpectation[] {
  return Object.freeze([
    Object.freeze({ validatorIdentity: "validator.intake-checks", actionIdentity: "action.intake", site: Object.freeze({ kind: "node", nodeIdentity: "node.intake" }) as ExecutionSiteRef }),
    Object.freeze({ validatorIdentity: "validator.review-isolation", actionIdentity: "action.review.blackbox", site: Object.freeze({ kind: "parallel-branch", nodeIdentity: "node.review", branchIdentity: "branch.blackbox" }) as ExecutionSiteRef }),
    Object.freeze({ validatorIdentity: "validator.review-isolation", actionIdentity: "action.review.whitebox", site: Object.freeze({ kind: "parallel-branch", nodeIdentity: "node.review", branchIdentity: "branch.whitebox" }) as ExecutionSiteRef }),
    Object.freeze({ validatorIdentity: "validator.aggregation-rules", actionIdentity: "action.aggregate", site: Object.freeze({ kind: "parallel-join", nodeIdentity: "node.review" }) as ExecutionSiteRef }),
    Object.freeze({ validatorIdentity: "validator.finalize-checks", actionIdentity: "action.finalize", site: Object.freeze({ kind: "node", nodeIdentity: "node.finalize" }) as ExecutionSiteRef }),
  ] satisfies ValidationActionExpectation[]);
}

export function createMinimalValidationActionAdapter(options: ValidationActionAdapterOptions) {
  const expectations = [...options.expectations];
  const correlationIdentity = canonicalDigest(options.correlation);
  const records: ValidationActionRecord[] = [];
  const consumed = new Set<string>();
  const behavior = options.behavior ?? "accepted";

  const invoke = async (request: ValidationActionRequest): Promise<ValidationActionDisposition> => {
    const expected = expectations[0];
    const identity = requestIdentity(request);
    if (expected === undefined) {
      return consumed.has(identity)
        ? { kind: "unavailable", reason: "VALIDATION_ACTION_DUPLICATE" }
        : { kind: "unavailable", reason: "VALIDATION_ACTION_MISMATCH" };
    }
    if (canonicalDigest(request.correlation) !== correlationIdentity
      || request.validatorIdentity !== expected.validatorIdentity
      || request.actionIdentity !== expected.actionIdentity
      || !same(request.site, expected.site)) {
      return { kind: "unavailable", reason: "VALIDATION_ACTION_MISMATCH" };
    }
    expectations.shift();
    consumed.add(identity);
    if (behavior === "throw") throw new Error("validation action failed");
    if (behavior === "malformed") throw new TypeError("validation action returned a malformed disposition");
    const disposition: ValidationActionDisposition = behavior === "rejected"
      ? { kind: "rejected", reason: "VALIDATION_ACTION_REJECTED" }
      : behavior === "unavailable"
        ? { kind: "unavailable", reason: "VALIDATION_ACTION_UNAVAILABLE" }
        : { kind: "accepted" };
    records.push(Object.freeze({ ...request, disposition }));
    return disposition;
  };

  const handlers: Array<readonly [string, HostOperationHandler]> = [];
  for (const validatorIdentity of new Set(options.expectations.map((expectation) => expectation.validatorIdentity))) {
    handlers.push([validatorIdentity, frozenHandler(async (input) => {
      const expected = expectations[0];
      if (expected === undefined || expected.validatorIdentity !== validatorIdentity) {
        const duplicate = options.expectations.find((candidate) => candidate.validatorIdentity === validatorIdentity);
        const disposition: ValidationActionDisposition = duplicate !== undefined && consumed.has(requestIdentity(duplicate))
          ? { kind: "unavailable", reason: "VALIDATION_ACTION_DUPLICATE" }
          : { kind: "unavailable", reason: "VALIDATION_ACTION_MISMATCH" };
        throw new ValidationActionUnavailableError(disposition);
      }
      const disposition = await invoke({ ...expected, correlation: options.correlation, input });
      if (disposition.kind === "unavailable") throw new ValidationActionUnavailableError(disposition);
      return Object.freeze({ accepted: disposition.kind === "accepted", value: null });
    })]);
  }
  handlers.push(["host-operation.finalize.v1", frozenHandler(async () => Object.freeze({
    accepted: true,
    value: Object.freeze({ terminal: "SUCCESS" }),
  }))]);

  return Object.freeze({
    hostOperations: Object.freeze(Object.fromEntries(handlers)),
    invoke,
    records: () => Object.freeze([...records]),
    remaining: () => Object.freeze([...expectations]),
  });
}
