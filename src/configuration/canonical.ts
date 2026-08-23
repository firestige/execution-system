import { createHash } from "node:crypto";

import type { ExecutionInstallationConfig } from "./types.js";

type JsonValue = null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };

function ordered(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(ordered);
  if (value !== null && typeof value === "object") {
    const object = value as { readonly [key: string]: JsonValue };
    return Object.fromEntries(Object.keys(object).sort().map((key) => [key, ordered(object[key] as JsonValue)]));
  }
  return value;
}

export function canonicalJsonBytes(value: JsonValue): Uint8Array {
  return Buffer.from(JSON.stringify(ordered(value)), "utf8");
}

export function canonicalConfigurationBytes(config: ExecutionInstallationConfig): Uint8Array {
  return canonicalJsonBytes(config as unknown as JsonValue);
}

export function coordinateIdentity(coordinate: string, value: JsonValue): string {
  const hash = createHash("sha256");
  hash.update(`${coordinate}\n`, "utf8");
  hash.update(canonicalJsonBytes(value));
  return `sha256:${hash.digest("hex")}`;
}

export function deepFreeze<T>(value: T): Readonly<T> {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
