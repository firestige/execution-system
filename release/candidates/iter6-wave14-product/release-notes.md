# WSR Execution 0.2.0

## What's new

3 commits

### Features

- run production Deliveries across Role Providers (#25)

### Bug Fixes

- **release** declare dual workflow contract compatibility

### Other

- record core-only 0.1.4 and promotion fix (#22)

## Compatibility

- `node`: `>=24.12.0 <25`
- `dsh`: `0.1.1-rc.2`
- `workflowContract`: `agentops.workflow-dsl@1.1.0 + agentops.workflow-dsl@2.0.0`
- `observationContract`: `agentops.observation@1.0.0`

## Upgrade guide

Install `wsr-execution@0.2.0` for host-neutral embedding. For DSH, install the independently versioned `dsh-wsr-execution` bundle from `firestige/wsr-dsh`.
