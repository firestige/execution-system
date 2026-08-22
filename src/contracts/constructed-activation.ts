import { z } from "zod";
import { existsSync } from "node:fs";

export const PROVIDER_IDENTITIES = ["dsh-headless", "copilot-sdk", "codex-cli"] as const;

export type ProviderIdentity = (typeof PROVIDER_IDENTITIES)[number];

export type ActivationBoundaryErrorCode =
  | "INVALID_ACTIVATION"
  | "ACTIVATION_BINDING_MISMATCH"
  | "ACTIVATION_CORRELATION_MISMATCH"
  | "ACTIVATION_FORBIDDEN_FIELD"
  | "ACTIVATION_NATIVE_IDENTITY_LEAK"
  | "ACTIVATION_SECRET_LEAK"
  | "ACTIVATION_NOT_DEEPLY_FROZEN"
  | "ACTIVATION_LOCAL_BINDING_INVALID"
  | "ACTIVATION_PROVIDER_UNSUPPORTED";

export class ActivationBoundaryError extends Error {
  override readonly name = "ActivationBoundaryError";

  constructor(
    readonly code: ActivationBoundaryErrorCode,
    message: string,
  ) {
    super(message);
  }
}

const identity = z.string().min(1);
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const absentIdentity = z.object({ kind: z.literal("ABSENT") }).strict();
const optionalCorrelationIdentity = z.union([identity, absentIdentity]);

const manifestSchema = z.object({
  revision: identity,
  bindingIdentity: identity,
  deliveryIdentity: identity,
  taskIdentity: identity,
  workflowIdentity: identity,
  workflowImplementationIdentity: identity,
  runtimeIdentity: identity,
  runtimeProfileIdentity: identity,
  packageIdentity: identity,
  snapshotIdentity: identity,
  packageDigest: digest,
  contractIdentity: identity,
  contractVersion: identity,
  contractFamilyBinding: identity,
  packageLocalReadOnlyPath: z.string().startsWith("/"),
  workspaceIdentity: identity,
  canonicalWorktreePath: z.string().startsWith("/"),
  actionIdentity: identity,
  roleIdentity: identity,
  routeIdentity: identity,
  driverResourceIdentity: identity,
  driverProjectionIdentity: identity,
  providerIdentity: identity,
  resourceBindingIdentities: z.array(identity).min(1),
  requiredCapabilities: z.array(identity).min(1),
  artifactIdentities: z.array(identity),
  interventionIdentity: optionalCorrelationIdentity,
  controlIdentity: optionalCorrelationIdentity,
}).strict();

const constructedActivationSchema = z.object({
  manifest: manifestSchema,
  delivery: z.object({ identity }).strict(),
  task: z.object({ identity, intent: z.string().min(1) }).strict(),
  workflow: z.object({ identity, implementationIdentity: identity }).strict(),
  runtime: z.object({ identity, profileIdentity: identity }).strict(),
  package: z.object({
    identity,
    snapshotIdentity: identity,
    digest,
    contract: z.object({
      identity,
      version: identity,
      familyBinding: identity,
    }).strict(),
    localReadOnlyPath: z.string().startsWith("/"),
  }).strict(),
  workspace: z.object({
    identity,
    canonicalWorktreePath: z.string().startsWith("/"),
  }).strict(),
  action: z.object({
    identity,
    roleIdentity: identity,
    routeIdentity: identity,
    driver: z.object({
      resourceIdentity: identity,
      projectionIdentity: identity,
      providerIdentity: identity,
      resourceBindingIdentities: z.array(identity).min(1),
      requiredCapabilities: z.array(identity).min(1),
    }).strict(),
  }).strict(),
  artifacts: z.array(z.object({ identity }).strict()),
  lifecycle: z.object({
    interventionIdentity: optionalCorrelationIdentity,
    controlIdentity: optionalCorrelationIdentity,
  }).strict(),
}).strict();

type DeepReadonly<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends readonly (infer Item)[]
    ? readonly DeepReadonly<Item>[]
    : T extends object
      ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
      : T;

export type ConstructedActivation = DeepReadonly<z.infer<typeof constructedActivationSchema>>;

export type ActivationPathInspector = (absolutePath: string) => boolean;

export interface ActivationValidationOptions {
  readonly pathExists?: ActivationPathInspector;
}

const FORBIDDEN_FIELDS = new Set([
  "workflowSelector",
  "source",
  "sourceDescriptor",
  "bundle",
  "bundleDescriptor",
  "latest",
  "download",
  "packageStore",
  "storeInstruction",
  "deliveryAdmission",
  "worktreeAdmission",
  "manifestWriter",
  "manifestPersistence",
  "observationControl",
  "otlpControl",
  "evidenceControl",
  "registry",
  "fallback",
]);
const NATIVE_IDENTITY_FIELDS = new Set(["threadId", "checkpointId", "sessionId", "processId"]);
const SECRET_FIELDS = new Set(["secret", "credential", "credentials", "apiKey"]);

function visitFields(
  value: unknown,
  visitor: (field: string) => void,
  seen = new Set<object>(),
): void {
  if (value === null || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  for (const [field, child] of Object.entries(value)) {
    visitor(field);
    visitFields(child, visitor, seen);
  }
}

function rejectProhibitedSurface(input: unknown): void {
  visitFields(input, (field) => {
    if (NATIVE_IDENTITY_FIELDS.has(field)) {
      throw new ActivationBoundaryError(
        "ACTIVATION_NATIVE_IDENTITY_LEAK",
        `Runtime-native identity '${field}' cannot cross the activation boundary`,
      );
    }
    if (SECRET_FIELDS.has(field)) {
      throw new ActivationBoundaryError(
        "ACTIVATION_SECRET_LEAK",
        `secret-bearing field '${field}' cannot cross the activation boundary`,
      );
    }
    if (FORBIDDEN_FIELDS.has(field)) {
      throw new ActivationBoundaryError(
        "ACTIVATION_FORBIDDEN_FIELD",
        `forbidden activation field '${field}'`,
      );
    }
  });
}

function isDeeplyFrozen(value: unknown, seen = new Set<object>()): boolean {
  if (value === null || typeof value !== "object" || seen.has(value)) return true;
  seen.add(value);
  if (!Object.isFrozen(value)) return false;
  return Object.values(value).every((child) => isDeeplyFrozen(child, seen));
}

function sameList(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameCorrelation(
  left: string | { readonly kind: "ABSENT" },
  right: string | { readonly kind: "ABSENT" },
): boolean {
  if (typeof left === "string" || typeof right === "string") return left === right;
  return left.kind === right.kind;
}

function rejectMismatch(activation: z.infer<typeof constructedActivationSchema>): void {
  const { manifest } = activation;
  const bindingMatches =
    manifest.deliveryIdentity === activation.delivery.identity &&
    manifest.taskIdentity === activation.task.identity &&
    manifest.workflowIdentity === activation.workflow.identity &&
    manifest.workflowImplementationIdentity === activation.workflow.implementationIdentity &&
    manifest.runtimeIdentity === activation.runtime.identity &&
    manifest.runtimeProfileIdentity === activation.runtime.profileIdentity &&
    manifest.packageIdentity === activation.package.identity &&
    manifest.snapshotIdentity === activation.package.snapshotIdentity &&
    manifest.packageDigest === activation.package.digest &&
    manifest.contractIdentity === activation.package.contract.identity &&
    manifest.contractVersion === activation.package.contract.version &&
    manifest.contractFamilyBinding === activation.package.contract.familyBinding &&
    manifest.packageLocalReadOnlyPath === activation.package.localReadOnlyPath &&
    manifest.workspaceIdentity === activation.workspace.identity &&
    manifest.canonicalWorktreePath === activation.workspace.canonicalWorktreePath &&
    manifest.roleIdentity === activation.action.roleIdentity &&
    manifest.routeIdentity === activation.action.routeIdentity &&
    manifest.driverResourceIdentity === activation.action.driver.resourceIdentity &&
    manifest.driverProjectionIdentity === activation.action.driver.projectionIdentity &&
    manifest.providerIdentity === activation.action.driver.providerIdentity &&
    sameList(manifest.resourceBindingIdentities, activation.action.driver.resourceBindingIdentities) &&
    sameList(manifest.requiredCapabilities, activation.action.driver.requiredCapabilities);

  if (!bindingMatches) {
    throw new ActivationBoundaryError(
      "ACTIVATION_BINDING_MISMATCH",
      "constructed activation does not match its persisted Manifest binding",
    );
  }

  const correlationMatches =
    manifest.actionIdentity === activation.action.identity &&
    sameList(manifest.artifactIdentities, activation.artifacts.map(({ identity: artifact }) => artifact)) &&
    sameCorrelation(manifest.interventionIdentity, activation.lifecycle.interventionIdentity) &&
    sameCorrelation(manifest.controlIdentity, activation.lifecycle.controlIdentity);

  if (!correlationMatches) {
    throw new ActivationBoundaryError(
      "ACTIVATION_CORRELATION_MISMATCH",
      "constructed activation identity/correlation differs from its persisted Manifest binding",
    );
  }
}

export function validateConstructedActivation(
  input: unknown,
  options: ActivationValidationOptions = {},
): ConstructedActivation {
  rejectProhibitedSurface(input);
  if (!isDeeplyFrozen(input)) {
    throw new ActivationBoundaryError(
      "ACTIVATION_NOT_DEEPLY_FROZEN",
      "constructed activation and every nested projection must already be frozen",
    );
  }

  const result = constructedActivationSchema.safeParse(input);
  if (!result.success) {
    throw new ActivationBoundaryError("INVALID_ACTIVATION", "constructed activation shape is invalid");
  }
  if (!PROVIDER_IDENTITIES.includes(result.data.action.driver.providerIdentity as ProviderIdentity)) {
    throw new ActivationBoundaryError(
      "ACTIVATION_PROVIDER_UNSUPPORTED",
      `unsupported Provider '${result.data.action.driver.providerIdentity}'`,
    );
  }
  rejectMismatch(result.data);
  const pathExists = options.pathExists ?? existsSync;
  if (
    !pathExists(result.data.package.localReadOnlyPath) ||
    !pathExists(result.data.workspace.canonicalWorktreePath)
  ) {
    throw new ActivationBoundaryError(
      "ACTIVATION_LOCAL_BINDING_INVALID",
      "admitted Package materialization and canonical Delivery worktree must exist",
    );
  }
  return input as ConstructedActivation;
}
