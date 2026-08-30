# Contributing to execution-system

Workflow Self-Recursive is an architecture-first developer preview by a small maintainer team. Contributions that keep the system auditable and the release pipeline honest are welcome.

## Reporting issues

Use the issue templates:

- [Bug report](.github/ISSUE_TEMPLATE/bug_report.yml) — a defect in Execution System or DSH Intake behavior.
- [Feature request](.github/ISSUE_TEMPLATE/feature_request.yml) — a new capability or improvement.
- [Compatibility issue](.github/ISSUE_TEMPLATE/compatibility.yml) — install / upgrade / DSH-version problems.

Before filing, check the [Known Limitations](README.md#known-limitations-and-deferred-work) and confirm the compatibility line (`dsh 0.1.1-rc.2`, Node `>=24.12 <25`). **Redact API keys and real paths in every log excerpt.**

## Response SLO

Targets, not guarantees, for a single-maintainer preview:

| Type | First response |
|---|---|
| Bug report | within 24h |
| Compatibility issue | within 24h (priority) |
| Feature request | within one week |
| Anything missing required fields | asked once for the missing info, then parked until provided |

A closed issue is not a verdict: reopening is always allowed.

## Development

- **Conventional commits only** — `feat:`, `fix:`, `docs:`, `refactor:`, `chore:`, `test:`, `ci:` with an optional scope. The changelog is generated from these messages; see below.
- **Changelog is generated, never hand-edited** — run `pnpm changelog:generate` after code changes and commit the regenerated `CHANGELOG.md` as its own commit (it is excluded from the changelog itself). `pnpm changelog:check` gates CI and rejects hand-edited drift.
- **Release authority** — this repository publishes only `wsr-execution`. DSH bundles are independently versioned and published from `firestige/wsr-dsh`; the retained legacy source is compatibility-only.
- **Gates before push** — `pnpm typecheck && pnpm build && pnpm test:full && pnpm check:generated && pnpm changelog:check`. DSH product qualification runs in `firestige/wsr-dsh`.

## Release process

See the [release process guide](https://github.com/firestige/workflow-self-recursive/blob/main/docs/guides/execution-release-process.md): local qualification → RC prerelease → remote verification → promote stable. The GitHub Release is the byte source of truth; the npm artifact is derived from its verified tarball, never from unverified source.

## License

By contributing you agree that your work is licensed under [Apache-2.0](LICENSE).
