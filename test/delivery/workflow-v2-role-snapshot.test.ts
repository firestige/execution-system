import { describe, expect, it } from "vitest";

import { extractWorkflowV2RoleSnapshot } from "../../src/delivery/index.js";

const sha = (character: string): string => `sha256:${character.repeat(64)}`;

function documents() {
  const roleResources = [
    { id: "role.prompt.facilitator", kind: "role-prompt", owner: "owned", contentIdentity: sha("a"), path: "prompts/facilitator.md", use: "role" },
    { id: "role.prompt.reviewer", kind: "role-prompt", owner: "owned", contentIdentity: sha("b"), path: "prompts/reviewer.md", use: "role" },
  ];
  return {
    packageDocument: {
      schemaVersion: "agentops.workflow-dsl@2.0.0",
      package: { name: "system-design", version: "2.0.0", digest: sha("1") },
      resources: { owned: roleResources, referenced: [] },
    },
    snapshotDocument: {
      schemaVersion: "agentops.workflow-dsl@2.0.0",
      snapshot: {
        id: "snapshot.system-design.2",
        digest: sha("2"),
        package: { name: "system-design", version: "2.0.0", digest: sha("1") },
        definition: { id: "workflow.system-design", version: "2.0.0", contentIdentity: sha("3") },
        resources: roleResources.map(({ id, owner, contentIdentity }) => ({ id, owner, contentIdentity })),
        routeBindings: [
          { action: "action.intake", role: "role.facilitator", route: "route.facilitator.intake" },
          { action: "action.review", role: "role.reviewer", route: "route.reviewer.review" },
        ],
      },
    },
    actionsDocument: {
      schemaVersion: "agentops.workflow-dsl@2.0.0",
      actions: [
        { id: "action.intake", responsibleAuthority: { kind: "role", role: "role.facilitator" }, allowedRoutes: ["route.facilitator.intake"] },
        { id: "action.review", responsibleAuthority: { kind: "role", role: "role.reviewer" }, allowedRoutes: ["route.reviewer.review"] },
        { id: "action.finalize", responsibleAuthority: { kind: "runtime", validator: "validator.finalize" } },
      ],
    },
    rolesDocument: {
      schemaVersion: "agentops.workflow-dsl@2.0.0",
      roles: [{ id: "role.facilitator" }, { id: "role.reviewer" }],
    },
    routesDocument: {
      schemaVersion: "agentops.workflow-dsl@2.0.0",
      routes: [
        { id: "route.facilitator.intake", role: "role.facilitator", resources: { rolePrompt: { id: "role.prompt.facilitator" }, capabilities: ["action-interaction", "structured-completion"] } },
        { id: "route.reviewer.review", role: "role.reviewer", resources: { rolePrompt: { id: "role.prompt.reviewer" }, capabilities: ["structured-completion"] } },
      ],
    },
  };
}

describe("Workflow DSL 2.0 Role Snapshot extraction", () => {
  it("derives every distinct Agent-action Role from exact Snapshot bindings and ignores Runtime-only Actions", () => {
    expect(extractWorkflowV2RoleSnapshot(documents())).toEqual({
      workflowSnapshot: {
        workflowId: "workflow.system-design",
        workflowVersion: "2.0.0",
        snapshotId: "snapshot.system-design.2",
        snapshotDigest: sha("2"),
      },
      agentActionRoles: [
        { roleId: "role.facilitator", rolePromptIdentity: "role.prompt.facilitator", rolePromptDigest: sha("a"), requiredCapabilities: ["action-interaction", "structured-completion"] },
        { roleId: "role.reviewer", rolePromptIdentity: "role.prompt.reviewer", rolePromptDigest: sha("b"), requiredCapabilities: ["structured-completion"] },
      ],
    });
  });

  it("rejects historical Route agent/model fields and historical resource kinds instead of reinterpreting 1.1", () => {
    const cases = [
      (() => { const value = structuredClone(documents()); (value.routesDocument.routes[0] as Record<string, unknown>).agent = { definition: { id: "agent.old" } }; return value; })(),
      (() => { const value = structuredClone(documents()); (value.routesDocument.routes[0]!.resources as Record<string, unknown>).model = { id: "model.old" }; return value; })(),
      (() => { const value = structuredClone(documents()); value.packageDocument.resources.referenced.push({ id: "model.old", kind: "model", owner: "referenced", contentIdentity: sha("c"), sourceLocator: { repository: "x/y", path: "model" }, use: "old" } as never); return value; })(),
      (() => { const value = structuredClone(documents()); value.packageDocument.schemaVersion = "agentops.workflow-dsl@9.0.0"; return value; })(),
    ];
    for (const value of cases) expect(() => extractWorkflowV2RoleSnapshot(value)).toThrowError(expect.objectContaining({ code: "WORKFLOW_PACKAGE_INVALID" }));
  });

  it("fails when one Role resolves to different Role prompts across Routes", () => {
    const value = structuredClone(documents());
    value.actionsDocument.actions.push({ id: "action.aggregate", responsibleAuthority: { kind: "role", role: "role.facilitator" }, allowedRoutes: ["route.facilitator.aggregate"] });
    value.routesDocument.routes.push({ id: "route.facilitator.aggregate", role: "role.facilitator", resources: { rolePrompt: { id: "role.prompt.reviewer" }, capabilities: ["structured-completion"] } });
    value.snapshotDocument.snapshot.routeBindings.push({ action: "action.aggregate", role: "role.facilitator", route: "route.facilitator.aggregate" });

    expect(() => extractWorkflowV2RoleSnapshot(value)).toThrowError(expect.objectContaining({ code: "WORKFLOW_PACKAGE_INVALID" }));
  });

  it("fails closed for missing Snapshot binding/resource closure and over 128 declared Roles", () => {
    const missingBinding = structuredClone(documents());
    missingBinding.snapshotDocument.snapshot.routeBindings.pop();
    expect(() => extractWorkflowV2RoleSnapshot(missingBinding)).toThrowError(expect.objectContaining({ code: "WORKFLOW_PACKAGE_INVALID" }));

    const missingResource = structuredClone(documents());
    missingResource.snapshotDocument.snapshot.resources.pop();
    expect(() => extractWorkflowV2RoleSnapshot(missingResource)).toThrowError(expect.objectContaining({ code: "WORKFLOW_PACKAGE_INVALID" }));

    const overBound = structuredClone(documents());
    overBound.rolesDocument.roles = Array.from({ length: 129 }, (_, index) => ({ id: `role${index}` }));
    expect(() => extractWorkflowV2RoleSnapshot(overBound)).toThrowError(expect.objectContaining({ code: "WORKFLOW_PACKAGE_INVALID" }));
  });
});
