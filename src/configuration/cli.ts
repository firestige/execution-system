#!/usr/bin/env node
import {
  dumpEffectiveExecutionConfiguration,
  initializeExecutionConfiguration,
  validateExecutionConfigurationFile,
} from "./tooling.js";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

export async function runExecutionConfigCli(args: readonly string[]): Promise<string> {
  const [command, configFile, format] = args;
  if (configFile === undefined) throw new TypeError("usage: execution-config init|copy|validate|dump-effective <absolute-path> [yaml|json]");
  if (command === "init" || command === "copy") {
    if (args.length > 3) throw new TypeError("execution-config does not accept nested overrides");
    const selected = format ?? (configFile.endsWith(".json") ? "json" : "yaml");
    if (selected !== "yaml" && selected !== "json") throw new TypeError("format must be yaml or json");
    await initializeExecutionConfiguration(configFile, selected);
    return "initialized from execution.default@execution.config@1.0.0\n";
  }
  if (args.length !== 2) throw new TypeError("execution-config does not accept nested overrides");
  if (command === "validate") {
    const loaded = await validateExecutionConfigurationFile(configFile);
    return `${loaded.installationConfigIdentity}\n`;
  }
  if (command === "dump-effective") {
    return dumpEffectiveExecutionConfiguration(configFile);
  }
  throw new TypeError("unknown execution-config command");
}

if (
  process.argv[1] !== undefined
  && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
) {
  runExecutionConfigCli(process.argv.slice(2)).then(
    (output) => { process.stdout.write(output); },
    (error: unknown) => {
      const value = error as { readonly code?: string; readonly message?: string };
      process.stderr.write(`${value.code ?? "CONFIG_TOOL_FAILED"}: ${value.message ?? "configuration command failed"}\n`);
      process.exitCode = 1;
    },
  );
}
