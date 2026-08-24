import { constants } from "node:fs";
import { copyFile } from "node:fs/promises";
import { isAbsolute } from "node:path";

import { canonicalJsonBytes } from "./canonical.js";
import { ConfigurationError } from "./errors.js";
import { loadExecutionInstallationConfig } from "./loader.js";
import type { ExecutionInstallationConfig } from "./types.js";

export function redactEffectiveConfiguration(config: ExecutionInstallationConfig): unknown {
  return {
    ...config,
    paths: {
      repositoryRoot: "[sensitive-path]",
      workspaceRoot: "[sensitive-path]",
      allowedWorktreeRoots: config.paths.allowedWorktreeRoots.map(() => "[sensitive-path]"),
      stateRoot: "[sensitive-path]",
      credentialStorePath: "[sensitive-path]",
      packageStoreRoot: "[sensitive-path]",
      intakeBindingStoreRoot: "[sensitive-path]",
      manifestRoot: "[sensitive-path]",
      currentSlotRoot: "[sensitive-path]",
      stagingRoot: "[sensitive-path]",
      runner: Object.fromEntries(Object.keys(config.paths.runner).map((key) => [key, "[sensitive-path]"])),
    },
    workflowSource: config.workflowSource.kind === "adapter"
      ? { ...config.workflowSource, adapterConfigFile: "[sensitive-path]" }
      : config.workflowSource,
    runner: {
      ...config.runner,
      provider: {
        ...config.runner.provider,
        baseUrl: "[sensitive-endpoint]",
        credentialRef: "[credential-reference]",
      },
    },
    observation: config.observation.endpoint === undefined
      ? config.observation
      : { ...config.observation, endpoint: "[sensitive-endpoint]" },
  };
}

export async function initializeExecutionConfiguration(destination: string, format: "yaml" | "json"): Promise<void> {
  if (!isAbsolute(destination)) throw new ConfigurationError("CONFIG_PATH_INVALID", ["destination"]);
  const source = new URL(`../../config/defaults/execution.default.${format}`, import.meta.url);
  try { await copyFile(source, destination, constants.COPYFILE_EXCL); }
  catch (cause) { throw new ConfigurationError("CONFIG_PATH_INVALID", ["destination"], { cause }); }
}

export const copyExecutionConfiguration = initializeExecutionConfiguration;

export async function validateExecutionConfigurationFile(configFile: string) {
  return loadExecutionInstallationConfig(configFile);
}

export async function dumpEffectiveExecutionConfiguration(configFile: string): Promise<string> {
  const loaded = await loadExecutionInstallationConfig(configFile);
  const output = {
    defaultsSource: "execution.default@execution.config@1.0.0",
    requiredComplete: true,
    installationConfigIdentity: loaded.installationConfigIdentity,
    effective: redactEffectiveConfiguration(loaded.config),
  };
  return `${Buffer.from(canonicalJsonBytes(output as never)).toString("utf8")}\n`;
}
