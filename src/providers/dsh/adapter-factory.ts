import { isAbsolute } from "node:path";
import { readFile, realpath } from "node:fs/promises";
import type { CredentialLeaseBroker, NativeProviderSessionFactory, ProviderAdapter, ProviderAdapterFactory } from "../provider.js";
import { ProviderAdapterStartupError, ProviderFactorySelectionError } from "../provider.js";
import { createDshNativeSessionFactory, DshCredentialLeaseBroker, type DshCredentialResolver } from "./native-session.js";
import { resolveDshPublicClosure, type DshPublicClosure } from "./public-closure.js";

export interface DshProviderAdapterConfiguration {
  readonly providerIdentity: "dsh-headless";
  readonly workspaceDirectory: string;
  readonly sessionStorageDirectory: string;
  readonly credentialStore: Readonly<{ readonly path: string; readonly watch: false }>;
  readonly maxParallelToolCalls: number;
}

function exactConfiguration(value: DshProviderAdapterConfiguration): DshProviderAdapterConfiguration {
  if (value === null || typeof value !== "object" || value.providerIdentity !== "dsh-headless") {
    throw new ProviderFactorySelectionError((value as { providerIdentity?: unknown } | undefined)?.providerIdentity as string ?? "unknown");
  }
  const keys = Object.keys(value).sort();
  if (keys.join(",") !== "credentialStore,maxParallelToolCalls,providerIdentity,sessionStorageDirectory,workspaceDirectory") {
    throw new TypeError("DSH Provider configuration is not exact");
  }
  if (!isAbsolute(value.workspaceDirectory) || !isAbsolute(value.sessionStorageDirectory) ||
    value.credentialStore === null || typeof value.credentialStore !== "object" ||
    Object.keys(value.credentialStore).sort().join(",") !== "path,watch" ||
    !isAbsolute(value.credentialStore.path) || value.credentialStore.watch !== false ||
    !Number.isSafeInteger(value.maxParallelToolCalls) || value.maxParallelToolCalls < 1) {
    throw new TypeError("DSH Provider configuration is invalid");
  }
  return Object.freeze({
    ...value,
    credentialStore: Object.freeze({ ...value.credentialStore }),
  });
}

async function mount(context: InstanceType<DshPublicClosure["Context"]>, plugin: { readonly prototype: Record<string, unknown> }, config: Record<string, unknown> = {}): Promise<void> {
  await context.plugin(plugin, config);
}

async function readExactCredentialDocument(closure: DshPublicClosure, filename: string): Promise<ReadonlyMap<string, string> | undefined> {
  try {
    return closure.parseCredentialsDocument(await readFile(filename, "utf8"), filename).refs;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw cause;
  }
}

function exactFileCredentialResolver(closure: DshPublicClosure, filename: string): DshCredentialResolver {
  return Object.freeze({
    async resolve(reference: string) {
      const value = (await readExactCredentialDocument(closure, filename))?.get(reference);
      return value === undefined ? undefined : { value, source: "configured-file" };
    },
  });
}

export class DshProviderAdapterFactory implements ProviderAdapterFactory<"dsh-headless", DshProviderAdapterConfiguration> {
  readonly key = "dsh-headless" as const;

  async create(candidate: DshProviderAdapterConfiguration): Promise<ProviderAdapter<"dsh-headless">> {
    const configuration = exactConfiguration(candidate);
    let closure: DshPublicClosure;
    try {
      closure = await resolveDshPublicClosure();
    } catch (cause) {
      throw new ProviderAdapterStartupError(this.key, cause);
    }
    const context = new closure.Context();
    try {
      const workspaceDirectory = await realpath(configuration.workspaceDirectory);
      await readExactCredentialDocument(closure, configuration.credentialStore.path);
      await mount(context, closure.SystemPrompt, {});
      await mount(context, closure.LlmRuntime, {});
      await mount(context, closure.ToolRuntime, {});
      await mount(context, closure.AgentRegistry, {});
      await mount(context, closure.SessionStore, {});
      await mount(context, closure.JsonlSessionPersistence, {
        root: configuration.sessionStorageDirectory,
        compression: "none",
      });
      await mount(context, closure.AgentLoop, {
        agents: [],
        maxParallelToolCalls: configuration.maxParallelToolCalls,
      });
      const agents = context.get("agents");
      const sessions = context.get("sessions");
      if (agents === undefined || sessions === undefined) {
        throw new TypeError("DSH Provider startup did not publish its exact runtime services");
      }
      const nativeSessions: NativeProviderSessionFactory = await createDshNativeSessionFactory({
        agents: agents as never,
        sessions: sessions as never,
        workspaceDirectory,
      });
      const credentialBroker: CredentialLeaseBroker = new DshCredentialLeaseBroker(exactFileCredentialResolver(closure, configuration.credentialStore.path));
      let disposed = false;
      return Object.freeze({
        key: this.key,
        sessions: nativeSessions,
        credentials: credentialBroker,
        async dispose() {
          if (disposed) return;
          disposed = true;
          await context.fiber.dispose();
        },
      });
    } catch (cause) {
      await context.fiber.dispose().catch(() => undefined);
      throw cause instanceof ProviderFactorySelectionError ? cause : new ProviderAdapterStartupError(this.key, cause);
    }
  }
}
