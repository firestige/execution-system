# WSR Execution 0.2.3

## What's new

3 commits

### Bug Fixes

- **delivery** normalize absent DSL2 Action input (#34)
- **release** install DSL2 checker for candidate gates (#33)

### Maintenance

- derive first-party Workflow fixture version

## Compatibility

- `node`: `>=24.12.0 <25`
- `dsh`: `0.1.1-rc.2`
- `workflowContract`: `agentops.workflow-dsl@2.0.0`
- `observationContract`: `agentops.observation@1.0.0`

## Upgrade guide

Install `wsr-execution@0.2.3` for host-neutral embedding. For DSH, install the independently versioned `dsh-wsr-execution` bundle from `firestige/wsr-dsh`.
