# runner.open-work.009 — Fault corpus result

Status: `PASSED_FOR_ITERATION_2`  
Implementation evidence: `execution-system@7d8ab836df2317451c5adbecca84c3d47317ee2d`

The named corpus is executable on one tree and preserves owner-specific uncertainty rather than
manufacturing success:

| Fault family | Executable evidence |
| --- | --- |
| activation/configuration | `test/faults/admitted-activation-faults.test.ts`, `test/integration/runner-factory.test.ts` |
| Provider protocol, persistence, credential and exact resume | `test/invocation/managed-invocation.test.ts`, `test/providers/dsh/native-session.test.ts`, `test/providers/dsh/adapter-factory.test.ts` |
| Action input and Workflow Wait correlation | `test/host/langgraph-coordinator-host.test.ts`, `test/coordinator/runner-adapter.test.ts` |
| unknown attempt, recovery and cancel races | `test/coordinator/runner-adapter.test.ts`, `test/invocation/managed-invocation.test.ts` |
| checkpoint/SQLite recovery and retirement | `test/host/langgraph-coordinator-host.test.ts` |
| Git scope, ignored paths, symlink containment and restore | `test/custody/git-custody.test.ts`, `test/providers/dsh/operation-authority.test.ts` |
| publication unknown/conflict and result preservation | `test/custody/git-custody.test.ts`, `test/coordinator/runner-adapter.test.ts` |
| partial/concurrent retirement and retry | `test/coordinator/runner-adapter.test.ts`, plus Host/Invocation/Custody owner suites |
| Observation throw/reject/hang isolation | `test/coordinator/runner-adapter.test.ts` |
| validation action reject/unavailable/throw/malformed/unregistered | `test/integration/minimal-walking-skeleton.test.ts`, `test/support/wave4/validation-action-adapter.test.ts` |

The final canonical run passed 27 test files and 312 tests. Coverage was 90.17% statements, 86.74%
branches, 94.61% functions, and 96.78% lines. The matching typecheck, build, generated freshness,
static boundary, and six-case feasibility gates also passed on that tree.

This result does not claim distributed/HA exactly-once semantics, production tuning defaults, remote
Provider availability, or complete domain validation.
