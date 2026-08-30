# Execution release adapter

This adapter implements `wsr.release-component@1.0.0` for the `wsr-execution` npm package. DSH bundle policy and publication are owned by `firestige/wsr-dsh`.

Local no-side-effect checks:

```sh
pnpm release:config:verify
pnpm release:matrix:verify
pnpm release:check-coordinates
pnpm release:simulate happy
pnpm release:artifacts <directory>
pnpm release:verify <directory>
pnpm release:publish-npm <directory>
```

The last command defaults to a dry plan. `--execute` is reserved for the trusted-publishing promotion workflow. It verifies the immutable manifest, publishes the core package, resumes only when existing registry bytes have the same digest, and asserts digest/description/versions/`latest` afterward.

Candidate dispatch is accepted only from `release/next`. After qualification, candidate publication mints a short-lived App token scoped to `wsr-execution` with Contents and Workflows write so a workflow-bearing archived target can be tagged. Stable promotion uses npm OIDC for the exact qualified tgz, then mints a fresh repository- and permission-scoped GitHub App token for the final GitHub Release operation.
