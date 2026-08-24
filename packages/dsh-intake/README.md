# DSH Intake for Workflow Self Recursive

Preview Intake Adapter distribution. It owns `/wsr`, the Intake-only tool, the first-party instruction skill, and private conversation-to-Delivery bindings. Workflow execution remains owned by the separately installed host-neutral Execution package.

Install the two release artifacts in order (the current DSH preview creates a pnpm workspace and therefore requires its workspace-root flag):

```sh
dsh plugin --profile workflow-execution add --workspace-root /absolute/path/workflow-self-recursive-execution-system-0.1.0.tgz
dsh plugin --profile workflow-execution add --workspace-root /absolute/path/workflow-self-recursive-dsh-intake-0.1.0.tgz
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
dsh --profile workflow-execution --dump-config
```

The locked DSH preview does not use profile `--help` as a plugin-command catalog. The exact WSR command reference is below; plugin startup never creates a Delivery.

Commands:

```text
/wsr list
/wsr create <name|name@latest|name@version>
/wsr recover [delivery-id]
/wsr status [delivery-id]
/wsr action finish
/wsr abandon <delivery-id>
```

The text and images in the current DSH turn are the Workflow prompt. There is no `--intent` argument. Ordinary answers sent while a bound Action awaits input are routed to that same Action; `/wsr action finish` requests the end of its multi-turn interaction and does not claim that the Action itself completed.

Use DSH's package lifecycle for an exact compatible update, removal, or reinstall:

```sh
dsh plugin --profile workflow-execution update --workspace-root @workflow-self-recursive/dsh-intake@<new-exact-version>
dsh plugin --profile workflow-execution remove --workspace-root @workflow-self-recursive/dsh-intake
dsh plugin --profile workflow-execution add --workspace-root @workflow-self-recursive/dsh-intake@<exact-version>
```

WSR does not intercept those package operations. The Execution state root, Manifest/current-slot, Runner state, `configFile`, and `bindingFile` stay outside the plugin installation directory. Starting a compatible reinstall resumes the same persisted Delivery binding from its last durable boundary; interaction state not persisted before process termination or package removal may be lost. If `--dump-config` reports a broken profile patch, restore the complete row shown above and rerun it; there is no fallback to another config path.
