# execution-system

English | [中文](README.zh-CN.md)

execution-system is the Execution System of Agent Ops Ledger — the small, host-neutral execution boundary that resolves and validates one exact Workflow Package, binds it in an immutable Delivery Manifest, coordinates the current Delivery, and emits bounded observations. It is embedded per repository/workspace and continues to run when Evidence or telemetry is unavailable.

Three modules carry this responsibility:

- **Delivery Binding** resolves one exact, locally `READY` Workflow Package (selector → validation → local `MISSING/STAGING/READY` store) and constructs Manifest content.
- **Runtime Interaction** owns canonical worktree exclusivity, the current Delivery slot, Manifest persistence, Runtime invocation, recovery, and final handling.
- **Delivery Observation** maps outbound bounded facts to a one-way, best-effort OTLP profile without controlling execution.

Runtimes are replaceable adapters behind a Core-owned seam: [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) is the first, and a first-party LangGraph adapter is planned.

## Developer preview

This repository is part of Agent Ops Ledger's architecture-first developer preview for trusted local use by individuals and small teams. It publishes the Execution design and component boundaries; it does not yet provide a runnable end-user release. **THERE WILL BE COMPATIBILITY-BREAKING CHANGES.**

## Get the source

This repository is normally consumed as a submodule of [Agent Ops Ledger](https://github.com/firestige/workflow-self-recursive):

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
