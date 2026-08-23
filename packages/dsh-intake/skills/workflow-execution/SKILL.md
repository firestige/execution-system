---
name: workflow-execution
description: Explicitly create, inspect, recover, finish an interaction, or abandon a Workflow Delivery.
disable-model-invocation: true
user-invocable: true
---

Use the operation that matches the user's explicit request:

- `list` discovers privacy-safe Delivery and worktree state.
- `create` starts a new Delivery from the current turn text and attachments.
- `recover` binds this conversation to an exact detached Delivery, or to this worktree's Delivery when no ID was supplied.
- `status` inspects the current binding or one exact Delivery ID.
- `action-finish` corresponds to `/wsr action finish`; it requests closure of the current Action interaction without claiming that the Action completed.
- `abandon` performs exact authorized abandonment.

Call `workflow_execution_intake` exactly once with that closed operation and the current host-neutral turn values. Do not call executable plugin code, Core, M01, Runner, an execution session, or a Provider service directly.
