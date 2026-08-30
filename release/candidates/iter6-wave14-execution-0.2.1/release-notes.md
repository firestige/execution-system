# WSR Execution 0.2.1

## What's new

2 commits

### Bug Fixes

- **delivery** prefer scoped Workflow releases (#28)
- **provider** close Codex output schemas (#27)

## Compatibility

- `node`: `>=24.12.0 <25`
- `dsh`: `0.1.1-rc.2`
- `workflowContract`: `agentops.workflow-dsl@1.1.0 + agentops.workflow-dsl@2.0.0`
- `observationContract`: `agentops.observation@1.0.0`

## Upgrade guide

Install `wsr-execution@0.2.1` for host-neutral embedding. For DSH, install the independently versioned `dsh-wsr-execution` bundle from `firestige/wsr-dsh`.
