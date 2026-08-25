# WSR DSH Intake

[![npm](https://img.shields.io/npm/v/wsr-dsh-intake)](https://www.npmjs.com/package/wsr-dsh-intake)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](../../LICENSE)

**Run version-bound, auditable agent workflows from your DeepSeek Harness chat.**

This is the DeepSeek Harness entry point of the [Workflow Self-Recursive Execution System](../..): it turns chat into Delivery — resolve one exact Workflow Package, bind an immutable Delivery Manifest, and run the workflow in an isolated Runner-owned execution context (`DSH-E`), never in the Intake context. The engine (`wsr-execution`) comes as this plugin's dependency.

## What you get

- **Sidebar tabs** — *Deliveries* and *Current status* panels for read-only control-plane queries (no chat command needed).
- **Chat commands** — `/wsr create`, `/wsr recover`, `/wsr action finish`, `/wsr abandon` with rendered Workflow nodes in the timeline.
- **Explicit skill** — `/workflow-execution` performs exactly one closed operation through the DSH-I-only `workflow_execution_intake` tool.
- **Isolated execution** — every admitted Workflow Action runs in a Runner-owned DSH execution context; the Intake never controls execution.
- **Crash recovery** — Manifest/current-slot and private bindings persist; restart resumes from the last durable boundary.

## Install

```sh
# 1. Approve the better-sqlite3 native build once (pnpm 11)
dsh plugin --profile web config set --location=project --json allowBuilds '{"better-sqlite3":true}'
# 2. Install this entry — the engine (wsr-execution) is its dependency
dsh plugin --profile web add wsr-dsh-intake
```

Requires Node `>=24.12 <25` and DSH `0.1.1-rc.2` (the shipped `web` profile is the reference interactive assembly; a custom profile contains only `dsh-base` and is not an interactive Intake surface). Core and Intake versions are locked together, so a single `add` installs both and a single `update` moves both.

## Configure

Point the plugin at durable state files outside the installation directory:

```yaml
# $DSH_HOME/profiles/web/cordis.patch.yml — the workflow-execution row
- id: workflow-execution
  config:
    configFile: /absolute/path/wsr-local/execution.yaml
    bindingFile: /absolute/path/wsr-local/dsh-intake-bindings.json
```

- `configFile` is the canonical `ExecutionInstallationConfig`; the plugin passes it to the public bootstrap without parsing or copying Provider, credential, Source, or OTLP settings. Initialize it with `execution-config init <path> yaml`, replace the `__REQUIRED__` values, and provision the referenced API key in an external DSH credential file.
- `bindingFile` holds adapter-private DSH session-to-Delivery correlations.

Verify the composed profile without starting a Workflow: `dsh --profile web --dump-config` (must not contain the API key), then `dsh web`.

## Quick start

From the target worktree, create a Delivery from chat:

```text
/wsr create implementation-workflow@0.3.0
Implement the requested change and preserve existing user edits.
```

Watch progress in the same conversation, inspect the bound Delivery in the sidebar **Deliveries** / **Current status** tabs, answer multi-turn Actions in chat, and finish an interaction with `/wsr action finish`.

## Commands

```text
/wsr list                         # privacy-safe Delivery and worktree state
/wsr create <name|name@latest|name@version>
/wsr recover [delivery-id]
/wsr status [delivery-id]
/wsr action finish
/wsr abandon <delivery-id>
```

Sidebar tabs are the default user entry; `list` and `status` remain compatibility/automation surfaces. The explicit skill `/workflow-execution` chooses one closed operation and calls `workflow_execution_intake` exactly once. The text and images in the current DSH turn are the Workflow prompt; ordinary answers sent while a bound Action awaits input are routed to that same Action.

## Surface boundary

The sidebar tabs display only read-only control-plane results. In the chat timeline, an interactive command enters a host-owned turn as the exact native user message; the Intake pre-step consumes that turn before any DSH-I model request. Acknowledgement, running state, Action output/input request, bounded errors, and unsuccessful terminal results render as assistant-style Workflow nodes without claiming model authorship; a successful terminal marker stays durable control-plane truth but is omitted from chat. Tool names, call identities, and argument structures never enter the presentation payload. Neither surface creates an assistant message or controls Execution. Malformed presentation text is replaced with `WSR_PRESENTATION_INVALID` rather than shown raw.

## Worktree authority

The plugin never substitutes the process cwd. For the [#93](https://github.com/firestige/workflow-self-recursive/issues/93) transition, an operation that must select a worktree uses the invoking conversation's exact registered workspace; it is accepted only when the invoking Agent is the current live instance, the DSH workspace registry resolves the session `cwd` to an absolute canonical workspace, and that workspace records the session as a member — otherwise `DSH_INTAKE_WORKSPACE_UNAUTHORIZED`. This authority is invocation-scoped and exact; it admits neither a common parent nor a sibling path. [Issue #94](https://github.com/firestige/workflow-self-recursive/issues/94) owns the later Delivery-selected worktree and its independent lifecycle.

## Update / remove

Use DSH's package lifecycle for an exact compatible update or removal:

```sh
dsh plugin --profile web update wsr-dsh-intake@<new-exact-version>
dsh plugin --profile web remove wsr-dsh-intake
```

WSR does not intercept those package operations. The Execution state root, Manifest/current-slot, Runner state, `configFile`, and `bindingFile` stay outside the plugin installation directory; a compatible reinstall resumes the same persisted Delivery binding from its last durable boundary.

## Known Limitations

- **Developer preview** — `0.1.x` is an MVP candidate; compatibility-breaking changes are possible.
- **Provisional worktree** — conversation workspace stands in until #94; authority is invocation-scoped.
- **DSH-only interactive surface** — the shipped `web` profile is the reference; custom profiles are not an interactive Intake surface.

## Related

- [Execution System README](../..) — system architecture, delivery forms, embedding API.
- [workflow-self-recursive](https://github.com/firestige/workflow-self-recursive) — the closed loop of Execution / Evidence / Evolution systems.

## License

[Apache-2.0](../../LICENSE)
