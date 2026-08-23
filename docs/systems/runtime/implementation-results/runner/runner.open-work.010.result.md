# runner.open-work.010 — Supported substrate matrix

Status: `PASSED_FOR_ITERATION_2`

| Component | Qualified version/range |
| --- | --- |
| Node.js | `>=24.12.0 <25` |
| pnpm | `9.15.0` |
| TypeScript | `7.0.2` |
| tsx | `4.23.12` |
| Vitest / coverage-v8 | `4.1.11` |
| LangGraph | `1.4.12` |
| LangChain core | `1.2.9` |
| LangGraph SQLite checkpoint adapter | `1.0.4` |
| DSH | `0.1.1-rc.2` |
| Zod | `4.2.0` |
| Git qualification environment | `2.52.0` |

`test/tooling/feasibility.test.ts` verifies the selected runtime exports and behaviors. Package and
lock identities remain unchanged by G06. LangGraph is the selected Workflow Host substrate, not part
of the stable Runner product identity. This record does not define a production-supported Git range
or tuning defaults; those require later measurement.

