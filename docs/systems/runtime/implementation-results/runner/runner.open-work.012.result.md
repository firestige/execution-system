# runner.open-work.012 — Internal interface result

Status: `PASSED_FOR_ITERATION_2`  
Implementation evidence: `execution-system@7d8ab836df2317451c5adbecca84c3d47317ee2d`

The creation plane is:

```text
Execution configuration
  -> RunnerFactory
  -> exact DSH ProviderAdapterFactory + exact LangGraph WorkflowHostAdapterFactory
  -> GitCustody + ManagedInvocation + WorkflowHost + RunnerCoordinator
  -> ExecutionRuntimeAdapter { execute, inspect, cancel }
```

The Agent call plane remains `Execution -> Coordinator -> Host -> Invocation`; narrow Host and
Coordinator capabilities retain their frozen G02–G05 ownership. The Interpreter is a deterministic
composition-time compiler, not a runtime caller. Runtime lanes cannot reverse-import composition.

`RunnerFactoryConfig` is a closed, deeply frozen data shape. Selection is exact-key, with no ambient
discovery, priority, fallback, preconstructed Provider/Host, or in-flight substitution. Creation
dependencies are descriptor-admitted capability snapshots. The test-scope validation catalog is
forwarded only to G04's private Host-operation seam and is absent from `RunnerFactoryConfig` and the
Runtime Adapter operation set.

Executable shape evidence is in `test/integration/runner-factory.test.ts`,
`test/integration/minimal-walking-skeleton.test.ts`, and
`test/tooling/static-boundary-check.test.ts`. Shared G00 contracts and all G01–G05 production files
remain unchanged by G06.

