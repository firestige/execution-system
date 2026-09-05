# WSR Execution 0.2.7

## What's new

6 commits

### Bug Fixes

- **qualification** bind product workflow selector
- **source** isolate exact release validation
- **release** close manual candidate entry points

### Maintenance

- **qualification** cover selector rejection paths
- **release** prepare Execution 0.2.7
- **harness** tolerate loaded static checks

## Compatibility

- `node`: `>=24.12.0 <25`
- `dsh`: `0.1.1-rc.2`
- `workflowContract`: `agentops.workflow-dsl@2.0.0`
- `observationContract`: `agentops.observation@1.0.0`

## Upgrade guide

Install `wsr-execution@0.2.7` for host-neutral embedding. For DSH, install the independently versioned `dsh-wsr-execution` bundle from `firestige/wsr-dsh`.
