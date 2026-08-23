import { isAbsolute, resolve } from "node:path";

import { ConfigurationError } from "./errors.js";

export interface IntakeProfileConfiguration { readonly configFile: string }

export function admitIntakeProfileConfiguration(candidate: unknown): IntakeProfileConfiguration {
  if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)
    || Reflect.ownKeys(candidate).length !== 1 || !Object.hasOwn(candidate, "configFile")) {
    throw new ConfigurationError("CONFIG_UNKNOWN_KEY", ["intakeProfile"]);
  }
  const descriptor = Object.getOwnPropertyDescriptor(candidate, "configFile");
  const configFile = descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined;
  if (typeof configFile !== "string" || !isAbsolute(configFile)) throw new ConfigurationError("CONFIG_PATH_INVALID", ["configFile"]);
  return Object.freeze({ configFile: resolve(configFile) });
}

