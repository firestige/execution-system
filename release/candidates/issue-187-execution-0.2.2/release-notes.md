# WSR Execution 0.2.2

## What's new

3 commits

### Features

- converge Execution quality for issue 187 (#31)

### Bug Fixes

- observe workflows and retain terminal delivery projections (#30)
- project workflow provider results into final output (#29)

## Compatibility

- `node`: `>=24.12.0 <25`
- `dsh`: `0.1.1-rc.2`
- `workflowContract`: `agentops.workflow-dsl@2.0.0`
- `observationContract`: `agentops.observation@1.0.0`

## Upgrade guide

Install `wsr-execution@0.2.2` for host-neutral embedding. For DSH, install the independently versioned `dsh-wsr-execution` bundle from `firestige/wsr-dsh`.
