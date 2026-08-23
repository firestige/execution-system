---
name: workflow-execution
description: Explicitly activate one Workflow through the Intake-only adapter.
disable-model-invocation: true
user-invocable: true
---

Collect the absolute worktree, selector, and task intent. Then call the Intake-only
`workflow_execution_activate` tool exactly once. Do not call Core, M01, Runner, or
an execution-session tool directly.
