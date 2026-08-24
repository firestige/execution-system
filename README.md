# execution-system

English | [中文](README.zh-CN.md)

execution-system is the Execution System of workflow-self-recursive — the small, host-neutral execution boundary that resolves and validates one exact Workflow Package, binds it in an immutable Delivery Manifest, coordinates the current Delivery, and emits bounded observations. It is embedded per repository/workspace and continues to run when Evidence or telemetry is unavailable.

Three modules carry this responsibility:

- **Delivery Binding** resolves one exact, locally `READY` Workflow Package (selector → validation → local `MISSING/STAGING/READY` store) and constructs Manifest content.
- **Runtime Interaction** owns canonical worktree exclusivity, the current Delivery slot, Manifest persistence, Runtime invocation, recovery, and final handling.
- **Delivery Observation** maps outbound bounded facts to a one-way, best-effort OTLP profile without controlling execution.

The public `ExecutionApplication` is host-neutral and can be embedded without a DSH Intake plugin. The separately packaged DSH Intake adapter is the first product entry; every admitted Workflow Action runs in a Runner-owned, isolated DSH execution context.

## Developer preview

This repository is part of workflow-self-recursive's architecture-first developer preview for trusted local use by individuals and small teams. Version `0.1.1` is an MVP candidate and may make compatibility-breaking changes.

## Release quickstart

1. Before release, run `pnpm quickstart:prepare` to build and verify both `0.1.1` artifacts and initialize local E2E configuration in one operation.
2. Copy `config/defaults/execution.default.yaml`, replace each `__REQUIRED__` value, and provision the referenced API key in the external DSH credential file (`version: 1`, `refs: ...`).
3. In a DSH profile with an interactive app (the shipped `web` profile is the reference), first run `dsh plugin --profile web add --workspace-root <absolute-execution-system-tarball>`, then run the same command with `<absolute-dsh-intake-tarball>`. The flag is required by the workspace created by the current DSH preview.
4. Set the plugin row's absolute `configFile` and `bindingFile`, then verify it with `dsh --profile web --dump-config` and `dsh --profile web --help`.
5. Start `dsh --profile web` from the target worktree. Use `/wsr create implementation-workflow@0.3.0`, `/wsr list`, and `/wsr status`. Restarting the Intake preserves Manifest/current-slot and private binding state for recovery.

The default Source is the configured `firestige/workflow-package` GitHub Release. `implementation-workflow@0.3.0` and `system-design-workflow@0.3.0` are downloaded, validated, and published to the local READY store; neither is embedded in an Execution artifact.

Workflow Package releases are package-scoped. A release tag is `workflow-package/<name>/v<version>` and contains exactly the archive, its package-release descriptor, and its SHA-256 checksum. Exact and latest selectors enumerate the same configured Release collection; latest applies SemVer ordering inside the requested package and excludes GitHub/SemVer prereleases, while an exact selector may select a prerelease. The immutable initial `0.3.0` cohort descriptor is interpreted by that same enumeration algorithm. Local READY and sticky-latest entries remain authoritative before any Source request. Build one release with `pnpm release:workflow-assets <package-directory> <destination> <40-character-revision>`.

See the repository-owned [local pre-release E2E guide](https://github.com/firestige/workflow-self-recursive/blob/main/docs/guides/dsh-execution-local-e2e.md), final [DSH quickstart](https://github.com/firestige/workflow-self-recursive/blob/main/docs/guides/dsh-execution-quickstart.md), [configuration reference](https://github.com/firestige/workflow-self-recursive/blob/main/docs/reference/execution-configuration.md), and [DSH Intake package reference](packages/dsh-intake/README.md). Release automation and user installation remain separate surfaces.

For direct embedding, import `ExecutionApplicationFactory`, `DefaultExecutionApplicationFactory`, `ExecutionRequest`, `TaskPrompt`, and the configuration types from the package root. Calling the default factory's `create(configFile, dependencies)` is the single production bootstrap path. The exact DSH runtime is an optional peer: package-root import/type consumers need not install it, while executing the current `dsh` Provider requires the embedding profile to provide `@deepseek-ai/dsh@0.1.1-rc.2`. The release includes `config/schema/execution.config.schema.json`, versioned defaults/examples, compiled TypeScript declarations, and `execution-config init|copy|validate|dump-effective`. Observation is disabled by default; set `observation.enabled: true` with a loopback OTLP base `endpoint` to enable the non-controlling exporter.

## Get the source

This repository is normally consumed as a submodule of [workflow-self-recursive](https://github.com/firestige/workflow-self-recursive):

```sh
git clone --recurse-submodules https://github.com/firestige/workflow-self-recursive.git
```

To clone it standalone:

```sh
git clone https://github.com/firestige/execution-system.git
```

## Documentation

- [Execution System design](https://github.com/firestige/workflow-self-recursive/blob/main/docs/systems/execution/project-execution-system.md)
- [Conceptual architecture](https://github.com/firestige/workflow-self-recursive/blob/main/docs/agent-architecture.md)
- [Workflow composition model](https://github.com/firestige/workflow-self-recursive/blob/main/docs/workflow-composition-model.md)
- [Execution–Evidence interaction contract](https://github.com/firestige/workflow-self-recursive/blob/main/docs/contracts/execution-evidence/interaction-contract.md)
- [Planned first-party LangGraph runtime profile](https://github.com/firestige/workflow-self-recursive/blob/main/docs/systems/runtime/first-party-langgraph-runtime-profile.md)

## License

[Apache-2.0](LICENSE)
