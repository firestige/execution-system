# runner.open-work.008 — DSH MVP result

Status: `MVP_DSH_ONLY_PARTIAL`  
Implementation evidence: `execution-system@7d8ab836df2317451c5adbecca84c3d47317ee2d`

The Runner factory creates the pinned DSH adapter from exact immutable configuration and composes
the real DSH `AgentRegistry`, `SessionStore`, `AgentLoop`, tool/LLM runtimes, DeepSeek adapter and
JSONL persistence. The formal walking skeleton projects the published minimal Workflow corpus into
a deeply frozen `RunnerActivationContext`, then enters through the Execution-owned
`ExecutionRuntimeAdapter`. A controlled local DeepSeek-compatible SSE endpoint is the only external
substitute; it observes four exact `Bearer synthetic-secret` requests from the configured credential
file. No ambient credential, Provider fallback, preconstructed Provider session, or raw Package input
enters production composition.

The path finishes with a typed `COMPLETED` result, guarded Git publication, four known owner
retirement facts, immutable settlement, and matching `inspect` truth. The adapter's own public
operations are exactly `execute`, `inspect`, and `cancel`.

Validation evidence is deliberately `VALIDATION_PROTOCOL_ONLY_PARTIAL`: five declared validation
Actions are correlated, called once, and consumed fail-closed through the G04 Host-operation seam.
The `validator.intake-checks` identity is inherited from the minimal Workflow's declared Action; it
does not mean that Execution Intake is connected in Iteration 2.
Rejected, unavailable, thrown, malformed, duplicate, stale, and unregistered dispositions are
covered. Iteration 2 does not implement Execution Intake or real domain validators; issue #87 owns
their Iteration 3 registration and composition.

Copilot SDK and Codex CLI remain typed fail-closed shells. Their concrete adapters remain open under
#84 and #85. Observation mapping/composition remains open under #86.
