# DSH Intake for Workflow Self Recursive

Preview Intake Adapter distribution. It owns `/wsr`, the Intake-only tool, the first-party instruction skill, and private conversation-to-Delivery bindings. Workflow execution remains owned by the separately installed host-neutral Execution package.

Install the two release artifacts in order (the current DSH preview creates a pnpm workspace and therefore requires its workspace-root flag):

```sh
dsh plugin --profile web add --workspace-root /absolute/path/workflow-self-recursive-execution-system-0.1.0.tgz
dsh plugin --profile web add --workspace-root /absolute/path/workflow-self-recursive-dsh-intake-0.1.0.tgz
```

The plugin accepts exactly two absolute-path settings in its DSH profile row:

```yaml
- id: workflow-execution
  config:
    configFile: /absolute/path/execution.yaml
    bindingFile: /absolute/path/dsh-intake-bindings.json
```

`configFile` is the canonical `ExecutionInstallationConfig`; the plugin passes it to the public bootstrap without parsing or copying Provider, credential, Source, or OTLP settings. `bindingFile` contains adapter-private DSH session-to-Delivery correlations. Keep both outside the plugin installation directory so upgrades do not replace durable state.

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
