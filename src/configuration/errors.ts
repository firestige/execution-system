export type ConfigurationErrorCode =
  | "CONFIG_EXTENSION_UNSUPPORTED"
  | "CONFIG_PARSE_FAILED"
  | "CONFIG_YAML_UNSAFE"
  | "CONFIG_DUPLICATE_KEY"
  | "CONFIG_UNKNOWN_KEY"
  | "CONFIG_DERIVED_KEY_FORBIDDEN"
  | "CONFIG_REQUIRED_INPUT_MISSING"
  | "CONFIG_REQUIRED_VALUE"
  | "CONFIG_SCHEMA_VERSION_UNSUPPORTED"
  | "CONFIG_TYPE_INVALID"
  | "CONFIG_PATH_INVALID"
  | "CONFIG_PATH_OUT_OF_SCOPE"
  | "CONFIG_URL_INVALID"
  | "CONFIG_SOURCE_INVALID"
  | "CONFIG_SOURCE_ADAPTER_UNKNOWN"
  | "CONFIG_RUNNER_INVALID"
  | "CONFIG_PROVIDER_INVALID"
  | "CONFIG_OBSERVATION_INVALID"
  | "CONFIG_OBSERVATION_ENDPOINT_INVALID"
  | "CONFIG_RANGE_INVALID";

export class ConfigurationError extends Error {
  constructor(
    readonly code: ConfigurationErrorCode,
    readonly fieldPaths: readonly string[] = [],
    _options?: ErrorOptions,
  ) {
    const guidance = code === "CONFIG_REQUIRED_INPUT_MISSING"
      ? "; replace each __REQUIRED__ marker with the documented deployment value"
      : "";
    super(`${code}${fieldPaths.length > 0 ? `: ${fieldPaths.join(", ")}` : ""}${guidance}`);
    this.name = "ConfigurationError";
  }
}
