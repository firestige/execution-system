# Execution release adapter

This adapter implements `wsr.release-component@1.0.0` for the lockstep `wsr-execution` and `wsr-dsh-intake` npm packages. It is the only Iter4 adapter that contains npm and DSH policy.

Local no-side-effect checks:

```sh
pnpm release:config:verify
pnpm release:matrix:verify
pnpm release:check-coordinates
pnpm release:simulate happy
pnpm release:simulate npm-core-published-intake-failed
pnpm release:artifacts <directory>
pnpm release:verify <directory>
pnpm release:publish-npm <directory>
```

The last command defaults to a dry plan. `--execute` is reserved for the trusted-publishing promotion workflow. It verifies the immutable manifest, publishes core then intake, resumes only when existing registry bytes have the same digest, and asserts digest/description/versions/`latest` afterward.

Candidate dispatch is accepted only from `release/next`. Stable promotion uses npm OIDC for the exact qualified tgz pair, then mints a repository- and permission-scoped GitHub App token for the final GitHub Release operation.
