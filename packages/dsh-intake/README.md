# DSH Intake for Workflow Self Recursive

Preview Intake Adapter distribution. It owns `/wsr`, the DSH-I-only `workflow_execution_intake` tool, the explicit `/workflow-execution` first-party instruction skill, and private conversation-to-Delivery bindings. Workflow execution remains owned by the separately installed host-neutral Execution package.

Candidate package identities are `@workflow-self-recursive/execution-system` and `@workflow-self-recursive/dsh-intake`, both at `0.1.1` for this compatibility tuple.

Install the two release artifacts into locked DSH's built-in `web` profile in order (the current DSH preview creates a pnpm workspace and therefore requires its workspace-root flag). Core's checkpoint dependency requires pnpm 11 to approve `better-sqlite3` under the profile's `allowBuilds` before package installation. The command below is for a fresh profile; on an existing profile, preserve all existing approvals and merge `better-sqlite3: true` into `$DSH_HOME/profiles/web/pnpm-workspace.yaml`. The Intake bundle supplies a bounded WSR chat node and read-only current-session sidebar tabs; a new custom profile contains only `dsh-base` and is not an interactive Intake surface:

```sh
dsh plugin --profile web config set --location=project --json allowBuilds '{"better-sqlite3":true}'
dsh plugin --profile web add --workspace-root /absolute/path/workflow-self-recursive-execution-system-0.1.1.tgz
dsh plugin --profile web add --workspace-root /absolute/path/workflow-self-recursive-dsh-intake-0.1.1.tgz
```

The plugin accepts exactly two absolute-path settings in its DSH profile row:

```yaml
- id: workflow-execution
  config:
    configFile: /absolute/path/execution.yaml
    bindingFile: /absolute/path/dsh-intake-bindings.json
```

`configFile` is the canonical `ExecutionInstallationConfig`; the plugin passes it to the public bootstrap without parsing or copying Provider, credential, Source, or OTLP settings. `bindingFile` contains adapter-private DSH session-to-Delivery correlations. Keep both outside the plugin installation directory so upgrades do not replace durable state.

Check the launcher syntax with `dsh --help`, then verify the composed profile without starting a Workflow:

```sh
dsh --profile web --dump-config
dsh web
```

The locked DSH preview does not use launcher or app help as a plugin-command catalog. Profile-level help belongs to the configured app and may keep that app running. The exact WSR command reference is below; plugin startup never creates a Delivery.

The surface boundary is deliberate. The sidebar tabs actively query Delivery list and current Delivery status and display only those read-only control-plane results. In the chat timeline, an interactive command enters a host-owned turn as the exact native user message; the Intake pre-step consumes that turn before any DSH-I model request. The generic command lifecycle stays hidden, while acknowledgement, running state, Action output/input request, bounded errors, and unsuccessful terminal results render as assistant-style Workflow nodes without claiming model authorship. A successful terminal marker remains durable control-plane truth but is omitted from chat so the final Action answer and its actions row end the turn. For structured completion, Action output prefers whitelisted user-visible text from `workflow_complete.result` over pre-completion narration. Tool names, call identities, and argument structures never enter the presentation payload, and the Client applies the same filter defensively to older events. Each visible Action answer uses DSH's clipboard primitive, copy icon, tooltip, sizing, and theme tokens to copy only the rendered answer. This makes the conversation non-blank, so New Session creates an isolated timeline and the earlier Workflow conversation remains separately reopenable. Neither surface creates an assistant message or controls Execution. Switching sessions switches the sidebar query target; malformed presentation text is replaced with `WSR_PRESENTATION_INVALID` rather than shown raw.

DSH may be launched from any directory: the plugin never substitutes the process cwd. For the issue #93 transition, an operation that must select a worktree uses the invoking conversation's exact registered workspace as its provisional worktree. The plugin accepts it only when the invoking Agent is the current live instance, the DSH workspace registry resolves the session header `cwd` to an absolute canonical workspace, and that workspace records the session as a member. A missing or mismatched registration fails with `DSH_INTAKE_WORKSPACE_UNAUTHORIZED`.

This authority is invocation-scoped and exact: it admits neither a common parent nor a sibling path, and it does not widen `paths.allowedWorktreeRoots` for public application callers. [Issue #94](https://github.com/firestige/workflow-self-recursive/issues/94) owns the later replacement of this provisional workspace-as-worktree value with a Delivery-selected worktree and its independent lifecycle. Mutation commands and consumed Action replies remain visible once as user input in chat even when admission, Source, recovery, or Runner handling fails; sidebar `list` and `status` queries remain sidebar-only.

Closed operations (the `list` and `status` slash aliases remain compatibility/automation surfaces, while sidebar tabs are the default user entry):

```text
/wsr list
/wsr create <name|name@latest|name@version>
/wsr recover [delivery-id]
/wsr status [delivery-id]
/wsr action finish
/wsr abandon <delivery-id>
```

The abstract command grammar used by release parity checks is `/wsr create <name|name@latest|name@version>`, `/wsr recover [delivery-id]`, `/wsr status [delivery-id]`, and `/wsr abandon <delivery-id>`. Invoke the explicit skill as `/workflow-execution`; its instruction chooses one closed operation and calls `workflow_execution_intake` exactly once.

The text and images in the current DSH turn are the Workflow prompt. There is no `--intent` argument. Ordinary answers sent while a bound Action awaits input are routed to that same Action; `/wsr action finish` requests the end of its multi-turn interaction and does not claim that the Action itself completed.

Use DSH's package lifecycle for an exact compatible update, removal, or reinstall. Update Core before Intake; remove Intake before Core:

```sh
dsh plugin --profile web update --workspace-root @workflow-self-recursive/execution-system@<new-exact-version>
dsh plugin --profile web update --workspace-root @workflow-self-recursive/dsh-intake@<new-exact-version>
dsh plugin --profile web remove --workspace-root @workflow-self-recursive/dsh-intake
dsh plugin --profile web remove --workspace-root @workflow-self-recursive/execution-system
dsh plugin --profile web add --workspace-root @workflow-self-recursive/execution-system@<exact-version>
dsh plugin --profile web add --workspace-root @workflow-self-recursive/dsh-intake@<exact-version>
```

WSR does not intercept those package operations. The Execution state root, Manifest/current-slot, Runner state, `configFile`, and `bindingFile` stay outside the plugin installation directory. Starting a compatible reinstall resumes the same persisted Delivery binding from its last durable boundary; interaction state not persisted before process termination or package removal may be lost. If `--dump-config` reports a broken profile patch, restore the complete row shown above and rerun it; there is no fallback to another config path.
