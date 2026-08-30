# WSR Execution 0.1.4

## What's new

4 commits

### Bug Fixes

- **release** render notes after prerelease tag (#16)

### Maintenance

- retire legacy DSH documentation verifier (#20)
- **release** retire legacy DSH publisher (#19)
- cut over to wsr authority coordinates

## Compatibility

- `node`: `>=24.12.0 <25`
- `dsh`: `0.1.1-rc.2`
- `workflowContract`: `agentops.workflow-dsl@1.1.0`
- `observationContract`: `agentops.observation@1.0.0`

## Upgrade guide

Install `wsr-execution@0.1.4` for host-neutral embedding. For DSH, install the independently versioned `dsh-wsr-execution` bundle from `firestige/wsr-dsh`.
