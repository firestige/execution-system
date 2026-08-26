# WSR Execution 0.1.3

## What's new

29 commits

### Features

- **intake** enforce exclusive session delivery binding
- **wave4** implement execution release adapter

### Bug Fixes

- **release** exclude candidate archives from changelog
- **intake** render successful terminal results
- **intake** retain session for terminal presentation
- **release** bind product qualification to core candidate
- **changelog** default destructured hash to empty string
- **changelog** resolve regen meta-commits via diff-tree
- **changelog** exclude changelog-only meta commits from generation
- **changelog** print section diff on drift
- **changelog** satisfy strict TS indexing in compareSemver
- **test** track 0.1.2 version assertions after metadata bump
- **intake** bind execution to conversation workspace
- **tooling** add opt-in DSH profile reinstall

### Documentation

- **contrib** add issue templates and response SLO
- **assets** add banner and architecture diagram
- **intake** add Model Experience and Security sections
- **intake** rewrite as plugin-facing marketing README
- **readme** rewrite as system-first marketing README
- **changelog** generate CHANGELOG.md from git history
- **assets** add 1280x640 social preview image

### Maintenance

- **wave4** close release policy oracles
- **docs** copy LICENSE into documentation verifier fixture
- **build** include dsh-intake in the pnpm workspace
- **test** derive version assertions from core manifest
- **release** bump to 0.1.2 with complete npm metadata
- **package** fill npm metadata for wsr-execution / wsr-dsh-intake
- **release** rename packages to wsr-execution / wsr-dsh-intake

### Other

- Iteration 3: complete interactive Intake and RC qualification (#3)

## Compatibility

- `node`: `>=24.12.0 <25`
- `dsh`: `0.1.1-rc.2`
- `workflowContract`: `agentops.workflow-dsl@1.1.0`
- `observationContract`: `agentops.observation@1.0.0`

## Upgrade guide

Install `wsr-execution@0.1.3` and `wsr-dsh-intake@0.1.3` as one lockstep upgrade.
