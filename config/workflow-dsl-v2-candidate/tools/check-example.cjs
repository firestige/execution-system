#!/usr/bin/env node
// Contract companion checker: schema, reference, graph/event, authority and digest closure only.
// It deliberately does not schedule Actions or implement Runtime state/retry/recovery behavior.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const Ajv = require('ajv');
const { canonicalDigest } = require('./canonicalize.cjs');

const ROOT = path.resolve(process.argv[2] || '.');
const SCHEMA_ROOT = path.resolve(__dirname, '..', 'schemas');
const read = relative => JSON.parse(fs.readFileSync(path.join(ROOT, relative), 'utf8'));
const rawDigest = relative => `sha256:${crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, relative))).digest('hex')}`;
const readSchema = name => JSON.parse(fs.readFileSync(path.join(SCHEMA_ROOT, name), 'utf8'));
const errors = [];
const check = (condition, message) => { if (!condition) errors.push(message); };
const ids = values => values.map(value => value.id);
const unique = (values, label) => check(new Set(values).size === values.length, `duplicate ${label}`);
const has = (values, id) => values.some(value => value.id === id);

const pkg = read('package.json');
const wf = read(pkg.documents.workflow);
const acts = read(pkg.documents.actions);
const roles = read(pkg.documents.roles);
const routes = read(pkg.documents.routes);
const arts = read(pkg.documents.artifacts);
const val = read(pkg.documents.validation);
const snapshot = read('snapshot.json');

const ajv = new Ajv({ allErrors: true, strict: true });
ajv.addSchema(readSchema('agentops.meta.schema.json'));
const schemaBindings = [
  ['package.json', pkg, 'package.schema.json'],
  [pkg.documents.workflow, wf, 'workflow-definition.schema.json'],
  [pkg.documents.actions, acts, 'actions.schema.json'],
  [pkg.documents.roles, roles, 'roles.schema.json'],
  [pkg.documents.routes, routes, 'routes.schema.json'],
  [pkg.documents.artifacts, arts, 'artifacts.schema.json'],
  [pkg.documents.validation, val, 'validation.schema.json'],
  ['snapshot.json', snapshot, 'package-snapshot.schema.json']
];
for (const [file, document, schemaName] of schemaBindings) {
  const validate = ajv.compile(readSchema(schemaName));
  if (!validate(document)) {
    errors.push(`${file}: schema validation failed: ${validate.errors.map(error => `${error.instancePath || '/'} ${error.message}`).join('; ')}`);
  }
}
if (errors.length) finish();

for (const [file, document] of schemaBindings.slice(1)) check(document.schemaVersion === pkg.schemaVersion, `${file}: schemaVersion must match package.schemaVersion`);
check(pkg.schemaVersion === 'agentops.workflow-dsl@2.0.0', 'package.schemaVersion');
check(pkg.authority.order.join(',') === 'workflow_action,role_prompt,action_prompt,skill,artifact_user', 'authority order must be canonical');
check(pkg.authority.conflictMode === 'fail-closed', 'conflictMode fail-closed');
check(pkg.package.definition.contentIdentity === rawDigest(pkg.documents.workflow), 'definition.contentIdentity must equal sha256(workflow.json)');
const packageForDigest = structuredClone(pkg);
delete packageForDigest.package.digest;
check(pkg.package.digest === canonicalDigest(packageForDigest), 'package digest mismatch');

const resourceIndex = new Map();
check([...pkg.resources.owned, ...pkg.resources.referenced].every(resource => !['agent-definition', 'model'].includes(resource.kind)), 'historical agent/model resource kind');
const resourceIdentities = [...pkg.resources.owned, ...pkg.resources.referenced].map(resource => resource.id);
unique(resourceIdentities, 'resource identity');
for (const resource of pkg.resources.owned) {
  check(fs.existsSync(path.join(ROOT, resource.path)), `owned resource file missing: ${resource.path}`);
  if (fs.existsSync(path.join(ROOT, resource.path))) check(resource.contentIdentity === rawDigest(resource.path), `owned digest mismatch: ${resource.id}`);
  resourceIndex.set(resource.id, resource);
}
for (const resource of pkg.resources.referenced) {
  check(Boolean(resource.sourceLocator.repository && resource.sourceLocator.path), `referenced resource needs sourceLocator: ${resource.id}`);
  resourceIndex.set(resource.id, resource);
}

const nodeIds = ids(wf.graph.nodes);
const terminalIds = ids(wf.graph.terminals);
const actionIds = ids(acts.actions);
const roleIds = ids(roles.roles);
const routeIds = ids(routes.routes);
const waitIds = ids(wf.waits || []);
const budgetIds = ids(wf.budgets || []);
const recoveryIds = ids(wf.recovery || []);
const stateFields = (wf.state.fields || []).map(field => field.name);
const hostOperationIds = ids(wf.hostOperations || []);
for (const [values, label] of [[nodeIds, 'node identity'], [terminalIds, 'terminal identity'], [actionIds, 'action identity'], [roleIds, 'role identity'], [routeIds, 'route identity'], [waitIds, 'wait identity'], [budgetIds, 'budget identity'], [recoveryIds, 'recovery identity']]) unique(values, label);
check(nodeIds.includes(wf.graph.start), 'graph.start must be a node');

const nodeById = new Map(wf.graph.nodes.map(node => [node.id, node]));
const terminalById = new Map(wf.graph.terminals.map(terminal => [terminal.id, terminal]));
const actionById = new Map(acts.actions.map(action => [action.id, action]));
const routeById = new Map(routes.routes.map(route => [route.id, route]));
const targetExists = target => target.startsWith('terminal:') ? terminalById.has(target.slice(9)) : nodeById.has(target);
const terminalKind = target => target.startsWith('terminal:') && terminalById.get(target.slice(9))?.kind;
const targetsOfRouting = routing => routing.kind === 'deterministic'
  ? routing.cases.map(entry => entry.target)
  : [...routing.branches.map(branch => branch.target), routing.fallback.target];
function resolvedResultSchema(action, nodeId) {
  const declared = action?.resultSchema;
  if (declared?.properties) return declared;
  if (!declared?.path || !declared?.contentIdentity) return undefined;
  const normalized = path.normalize(declared.path);
  const resource = [...resourceIndex.values()].find(candidate => candidate.kind === 'schema'
    && path.normalize(candidate.path || candidate.sourceLocator?.path || '') === normalized
    && candidate.contentIdentity === declared.contentIdentity);
  check(Boolean(resource), `node ${nodeId} routing result schema must resolve to an exact declared schema resource`);
  if (!resource) return undefined;
  if (resource.owner !== 'owned') {
    check(false, `node ${nodeId} routing result schema bytes must be materialized for admission`);
    return undefined;
  }
  try {
    return read(resource.path);
  } catch {
    check(false, `node ${nodeId} routing result schema must be readable JSON`);
    return undefined;
  }
}

for (const node of wf.graph.nodes) {
  if (node.action) check(actionById.has(node.action), `node ${node.id} action ${node.action} must exist`);
  if (node.kind === 'parallel') {
    check(node.branches.every(branch => branch.required === true), `node ${node.id}: parallel branches are all required`);
    unique(ids(node.branches), `branch identity on ${node.id}`);
    for (const branch of node.branches) check(actionById.has(branch.action), `node ${node.id} branch action ${branch.action} unknown`);
    if (node.join.kind === 'aggregator') check(actionById.has(node.join.action), `node ${node.id} aggregator action ${node.join.action} unknown`);
    if (node.selection) {
      check(node.selection.source.kind === 'state' || node.selection.source.kind === 'site-result', `node ${node.id} selection must use an admitted state or site-result source`);
      if (node.selection.source.kind === 'state') check(stateFields.includes(node.selection.source.field), `node ${node.id} selection state source unknown`);
    }
  }
  if (node.wait) check(waitIds.includes(node.wait), `node ${node.id} wait ${node.wait} unknown`);
  if (node.recovery) check(recoveryIds.includes(node.recovery), `node ${node.id} recovery ${node.recovery} unknown`);
  if (node.budget) check(budgetIds.includes(node.budget), `node ${node.id} budget ${node.budget} unknown`);
  if (node.routing) {
    for (const target of targetsOfRouting(node.routing)) check(targetExists(target), `routing target unknown: ${target}`);
    if (node.routing.kind === 'deterministic') {
      const producer = node.kind === 'parallel' && node.join.kind === 'aggregator' ? actionById.get(node.join.action) : actionById.get(node.action);
      const property = resolvedResultSchema(producer, node.id)?.properties?.[node.routing.output];
      check(Boolean(property), `node ${node.id} routing output must be a top-level Action result property`);
      const allowed = property?.enum || (property?.type === 'boolean' ? [true, false] : undefined);
      check(Boolean(allowed), `node ${node.id} routing output must be strict boolean or closed enum`);
      if (allowed) {
        check(node.routing.cases.every(entry => allowed.some(value => Object.is(value, entry.value))), `node ${node.id} routing case is outside result schema`);
        check(allowed.length === node.routing.cases.length
          && allowed.every(value => node.routing.cases.filter(entry => Object.is(value, entry.value)).length === 1),
        `node ${node.id} routing cases must cover each result value exactly once`);
      }
    } else {
      unique(ids(node.routing.branches), `semantic branch identity on ${node.id}`);
    }
  }
  if (node.checkpoint && node.checkpoint.mode !== 'never') {
    const required = ['delivery', 'snapshot', 'graphNode', 'action', 'attempt', 'inputBindings', 'artifactBindings', 'branchResults', 'budgets', 'pendingWait'];
    check(required.every(binding => node.checkpoint.bindings.includes(binding)), `node ${node.id} checkpoint missing portable continuation binding`);
  }
}

unique(ids(wf.dataflow.edges), 'dataflow edge identity');
const sinkKeys = new Set();
for (const edge of wf.dataflow.edges) {
  const source = edge.source;
  const target = edge.target;
  if (source.kind === 'state') check(stateFields.includes(source.field), `dataflow ${edge.id} state source unknown`);
  if (target.kind === 'state') check(stateFields.includes(target.field), `dataflow ${edge.id} state target unknown`);
  if (source.kind === 'artifact') check(has(arts.artifacts, source.artifactIdentity), `dataflow ${edge.id} artifact source unknown`);
  if (target.kind === 'artifact') check(has(arts.artifacts, target.artifactIdentity), `dataflow ${edge.id} artifact target unknown`);
  const sink = JSON.stringify(target);
  check(!sinkKeys.has(sink), `duplicate dataflow sink ${sink}`);
  sinkKeys.add(sink);
}
unique(hostOperationIds, 'Host operation identity');
for (const operation of wf.hostOperations || []) {
  check(operation.requiredCapabilities.length > 0, `Host operation ${operation.id} needs a closed capability`);
}

for (const edge of wf.graph.edges) {
  check(nodeById.has(edge.from), `edge ${edge.id} source unknown`);
  check(targetExists(edge.to), `edge target unknown: ${edge.to}`);
  check(!nodeById.get(edge.from)?.routing, `node ${edge.from} mixes explicit routing with an ordinary edge`);
}
unique(ids(wf.graph.edges), 'ordinary edge identity');
unique(ids(wf.graph.eventEdges), 'event edge identity');
const ordinaryBySource = new Map(nodeIds.map(id => [id, wf.graph.edges.filter(edge => edge.from === id)]));
for (const node of wf.graph.nodes) {
  if (['wait', 'wait-renewal'].includes(node.kind)) {
    check(ordinaryBySource.get(node.id).length === 0, `node ${node.id} cannot have an ordinary outgoing edge`);
  }
  if (!node.routing) check(ordinaryBySource.get(node.id).length <= 1, `node ${node.id} has multiple ordinary successors without routing`);
}

// Internal Planner invocations are induced only by semantic-routing nodes. They must be acyclic.
const semanticIds = new Set(wf.graph.nodes.filter(node => node.routing?.kind === 'semantic').map(node => node.id));
const semanticGraph = new Map([...semanticIds].map(id => [id, []]));
for (const id of semanticIds) {
  for (const target of targetsOfRouting(nodeById.get(id).routing)) if (semanticIds.has(target)) semanticGraph.get(id).push(target);
}
const visiting = new Set();
const visited = new Set();
function visitPlanner(id) {
  if (visiting.has(id)) return false;
  if (visited.has(id)) return true;
  visiting.add(id);
  for (const target of semanticGraph.get(id)) if (!visitPlanner(target)) return false;
  visiting.delete(id);
  visited.add(id);
  return true;
}
for (const id of semanticIds) check(visitPlanner(id), `planner invocation cycle at ${id}`);

const eventGroups = new Map();
for (const edge of wf.graph.eventEdges) {
  check(nodeById.has(edge.from), `event edge ${edge.id} source unknown`);
  check(targetExists(edge.to), `event edge target unknown: ${edge.to}`);
  const key = `${edge.from}:${edge.event}`;
  const group = eventGroups.get(key) || [];
  group.push(edge);
  eventGroups.set(key, group);
}
for (const [key, group] of eventGroups) check(group.length === 1, `duplicate event edge for ${key}`);

function expectedEvents(node) {
  const result = new Set(['cancelled']);
  if (node.kind !== 'wait') result.add('nonretryable-failure');
  if (node.kind === 'wait') result.add('wait-expired');
  if (node.budget || node.kind === 'wait-renewal') result.add('budget-exhausted');
  if (node.continuationSource === true) result.add('continuation-invalid');
  return result;
}
function compatibleEventTarget(node, event, target) {
  const targetNode = nodeById.get(target);
  const targetTerminal = terminalKind(target);
  if (event === 'budget-exhausted') {
    if (node.kind === 'cleanup') return targetTerminal === (node.disposition === 'cancellation' ? 'cancelled' : 'failure');
    if (node.kind === 'wait-renewal') return targetTerminal === 'incomplete';
    return targetTerminal === 'incomplete' || ['wait', 'recovery'].includes(targetNode?.kind);
  }
  if (event === 'wait-expired') return targetTerminal === 'incomplete' || ['action', 'recovery'].includes(targetNode?.kind) || (targetNode?.kind === 'wait-renewal' && targetNode.wait === node.wait);
  if (event === 'cancelled') {
    if (node.kind === 'cleanup') return targetTerminal === (node.disposition === 'cancellation' ? 'cancelled' : 'failure');
    return targetTerminal === 'cancelled' || (targetNode?.kind === 'cleanup' && targetNode.disposition === 'cancellation');
  }
  if (event === 'nonretryable-failure') {
    if (node.kind === 'cleanup') return targetTerminal === (node.disposition === 'cancellation' ? 'cancelled' : 'failure');
    return targetTerminal === 'failure' || (targetNode?.kind === 'cleanup' && targetNode.disposition === 'failure');
  }
  return targetTerminal === 'failure' || (targetNode?.kind === 'cleanup' && ['failure', 'continuation'].includes(targetNode.disposition));
}
for (const node of wf.graph.nodes) {
  const expected = expectedEvents(node);
  for (const event of ['budget-exhausted', 'wait-expired', 'cancelled', 'nonretryable-failure', 'continuation-invalid']) {
    const group = eventGroups.get(`${node.id}:${event}`) || [];
    if (expected.has(event)) check(group.length === 1, `missing event edge for ${node.id}:${event}`);
    else check(group.length === 0, `prohibited event edge for ${node.id}:${event}`);
    for (const edge of group) check(compatibleEventTarget(node, event, edge.to), `incompatible event target for ${node.id}:${event}`);
  }
}

const cleanupNodes = new Map(wf.graph.nodes.filter(node => node.kind === 'cleanup').map(node => [node.id, node]));
function verifyCleanup(start, current, visiting = new Set()) {
  if (visiting.has(current.id)) {
    check(false, `cleanup cycle reachable from ${start.id}`);
    return;
  }
  const nextVisiting = new Set(visiting).add(current.id);
  for (const edge of ordinaryBySource.get(current.id)) {
    if (edge.to.startsWith('terminal:')) {
      const expected = start.disposition === 'cancellation' ? 'cancelled' : 'failure';
      check(terminalKind(edge.to) === expected, `cleanup ${start.id} violates sticky ${start.disposition} disposition`);
      continue;
    }
    const target = cleanupNodes.get(edge.to);
    check(Boolean(target), `cleanup ${current.id} reaches non-cleanup node ${edge.to}`);
    if (target) verifyCleanup(start, target, nextVisiting);
  }
}
for (const cleanup of cleanupNodes.values()) verifyCleanup(cleanup, cleanup);

for (const budget of wf.budgets || []) {
  const evaluatorPath = path.normalize(budget.evaluator.path).replace(/^(\.\.[/\\])+/, '');
  const exact = [...resourceIndex.values()].some(resource => ['validator', 'cli'].includes(resource.kind)
    && path.normalize(resource.path || resource.sourceLocator?.path || '') === evaluatorPath
    && resource.contentIdentity === budget.evaluator.contentIdentity);
  check(exact, `budget ${budget.id} evaluator is not an exact declared evaluator resource`);
}
for (const recovery of wf.recovery || []) check(recovery.noBlindReplay === true, `recovery ${recovery.id} must declare noBlindReplay`);
for (const handoff of wf.handoffs || []) check(handoff.semanticOnly === true, `handoff ${handoff.id} must be semanticOnly`);
for (const consumed of wf.consumedHandoffs || []) check(consumed.mustNotWeaken === true, `consumedHandoff ${consumed.id} must declare mustNotWeaken`);

for (const role of roles.roles) check(role.authorityBoundary.concerns.length > 0, `role ${role.id} needs a non-empty Workflow authority concern boundary`);
for (const action of acts.actions) {
  const roleAction = action.responsibleAuthority.kind === 'role';
  if (roleAction) {
    check(roleIds.includes(action.responsibleAuthority.role), `action ${action.id} role unknown`);
    check(action.allowedRoutes.length > 0, `action ${action.id} needs an allowed Route`);
  } else check(has(val.validators, action.responsibleAuthority.validator), `action ${action.id} runtime validator unknown`);
  for (const routeId of action.allowedRoutes || []) {
    check(routeIds.includes(routeId), `action ${action.id} route ${routeId} unknown`);
    if (routeById.has(routeId)) check(routeById.get(routeId).role === action.responsibleAuthority.role, `action ${action.id} route ${routeId} crosses its one responsible Role`);
  }
  check(action.gate.freeTextBypass === 'prohibited', `action ${action.id} gate must prohibit free-text bypass`);
  for (const validator of action.gate.deterministic || []) check(has(val.validators, validator), `action ${action.id} gate validator ${validator} unknown`);
}

check(roles.roles.length <= 128, 'Role count exceeds 128');
const rolePromptBindings = new Map();
const boundInstructions = new Set();
for (const route of routes.routes) {
  check(roleIds.includes(route.role), `route ${route.id} role unknown`);
  check(route.agent === undefined, `route ${route.id} must not contain historical agent`);
  check(route.resources.model === undefined, `route ${route.id} must not contain historical model`);
  check(route.resources.capabilities.includes('structured-completion'), `route ${route.id} must provide structured-completion`);
  const scope = route.resources.sessionPolicy.scope;
  if (scope.kind === 'data-bound' && scope.source.kind === 'state') check(stateFields.includes(scope.source.field), `route ${route.id} session scope state source unknown`);
  const bindings = [
    ['rolePrompt', route.resources.rolePrompt, 'role-prompt'],
    ['driver', route.resources.driver, 'driver'],
    ...route.resources.skills.map(ref => ['skill', ref, 'skill']),
    ...route.resources.tools.map(ref => ['tool', ref, 'tool']),
    ...route.resources.actionPrompts.map(entry => ['actionPrompt', entry.prompt, 'action-prompt'])
  ];
  for (const [label, ref, kind] of bindings) {
    const resource = resourceIndex.get(ref.id);
    check(Boolean(resource), `route ${route.id} resource ref ${ref.id} undeclared`);
    if (resource) check(resource.kind === kind, `route ${route.id} ${label} ${ref.id} must reference kind ${kind}`);
    if (['role-prompt', 'action-prompt', 'skill'].includes(kind)) boundInstructions.add(ref.id);
  }
  const rolePrompt = route.resources.rolePrompt.id;
  const priorRolePrompt = rolePromptBindings.get(route.role);
  check(priorRolePrompt === undefined || priorRolePrompt === rolePrompt, `role ${route.role} binds multiple Role prompts`);
  rolePromptBindings.set(route.role, rolePrompt);
  for (const prompt of route.resources.actionPrompts) {
    const action = actionById.get(prompt.action);
    check(Boolean(action), `route ${route.id} actionPrompt action ${prompt.action} unknown`);
    if (action) check((action.allowedRoutes || []).includes(route.id), `route ${route.id} binds ${prompt.action} without Action authorization`);
  }
}
for (const resource of resourceIndex.values()) if (['role-prompt', 'action-prompt', 'skill'].includes(resource.kind)) check(boundInstructions.has(resource.id), `instruction resource ${resource.id} is not bound through any route`);

for (const artifact of arts.artifacts) {
  check(actionById.has(artifact.producedBy), `artifact ${artifact.id} producedBy unknown`);
  for (const consumer of artifact.consumedBy || []) check(actionById.has(consumer), `artifact ${artifact.id} consumedBy ${consumer} unknown`);
}
for (const aggregation of val.aggregation) {
  const parallel = nodeById.get(aggregation.parallelNode);
  check(parallel?.kind === 'parallel', `aggregation ${aggregation.id} parallelNode unknown`);
  check(parallel?.join.kind === 'aggregator' && parallel.join.action === aggregation.aggregatorAction, `aggregation ${aggregation.id} must bind the explicit join Action`);
}
for (const review of val.review) {
  check(actionById.has(review.action), `review ${review.id} action unknown`);
  check(review.isolation === 'session-isolated', `review ${review.id} must be isolated`);
  check(has(arts.artifacts, review.admission.findingShape), `review ${review.id} findingShape unknown`);
  const findingShape = arts.artifacts.find(artifact => artifact.id === review.admission.findingShape);
  if (findingShape) check(findingShape.producedBy === review.action, `review ${review.id} findingShape must be produced by its exact Reviewer Action`);
}
for (const kind of ['positive', 'negative', 'recovery']) check(val.conformance.some(fixture => fixture.class === kind), `conformance corpus missing ${kind}`);

const documentKinds = { workflow: pkg.documents.workflow, actions: pkg.documents.actions, roles: pkg.documents.roles, routes: pkg.documents.routes, artifacts: pkg.documents.artifacts, validation: pkg.documents.validation };
const expectedDocuments = Object.entries(documentKinds).map(([kind, file]) => ({ kind, contentIdentity: rawDigest(file) }));
check(JSON.stringify(snapshot.snapshot.documents) === JSON.stringify(expectedDocuments), 'Snapshot document bindings mismatch');
check(JSON.stringify(snapshot.snapshot.graph.dataEdges) === JSON.stringify(ids(wf.dataflow.edges)), 'Snapshot data-edge bindings mismatch');
check(JSON.stringify(snapshot.snapshot.graph.hostOperations) === JSON.stringify(hostOperationIds), 'Snapshot Host-operation bindings mismatch');
const expectedResources = [...pkg.resources.owned, ...pkg.resources.referenced].map(resource => ({ id: resource.id, owner: resource.owner, contentIdentity: resource.contentIdentity }));
check(JSON.stringify(snapshot.snapshot.resources) === JSON.stringify(expectedResources), 'Snapshot resource bindings mismatch');
const expectedRoutes = acts.actions.flatMap(action => (action.allowedRoutes || []).map(route => ({ action: action.id, role: action.responsibleAuthority.role, route })));
check(JSON.stringify(snapshot.snapshot.routeBindings) === JSON.stringify(expectedRoutes), 'Snapshot route bindings mismatch');
check(snapshot.snapshot.package.name === pkg.package.name && snapshot.snapshot.package.version === pkg.package.version && snapshot.snapshot.package.digest === pkg.package.digest, 'Snapshot Package binding mismatch');
check(snapshot.snapshot.definition.id === wf.workflow.id && snapshot.snapshot.definition.version === wf.workflow.version && snapshot.snapshot.definition.contentIdentity === pkg.package.definition.contentIdentity, 'Snapshot Definition binding mismatch');
check(JSON.stringify(snapshot.snapshot.graph.nodes) === JSON.stringify(nodeIds), 'Snapshot node binding mismatch');
check(JSON.stringify(snapshot.snapshot.graph.eventEdges) === JSON.stringify(ids(wf.graph.eventEdges)), 'Snapshot event-edge binding mismatch');
check(JSON.stringify(snapshot.snapshot.graph.terminals) === JSON.stringify(terminalIds), 'Snapshot terminal binding mismatch');
check(snapshot.snapshot.authority.order.join(',') === pkg.authority.order.join(','), 'Snapshot authority order mismatch');
const expectedMergeProof = canonicalDigest({ authority: pkg.authority, routes: expectedRoutes, resources: expectedResources });
check(snapshot.snapshot.authority.mergeProof === expectedMergeProof, 'Snapshot merge proof mismatch');
const snapshotForDigest = structuredClone(snapshot);
delete snapshotForDigest.snapshot.digest;
check(snapshot.snapshot.digest === canonicalDigest(snapshotForDigest), 'snapshot digest mismatch');

const forbidden = ['stategraph', 'langgraph.json', 'langgraph', 'checkpoint_id', 'thread_id', 'memorysaver', 'sqlitesaver', 'add_messages', 'last_value', 'annotations.root', 'send api', 'interrupt(', 'codex ', 'copilot ', 'invocationid', 'attemptid', 'providercheckpoint', 'sessionid'];
function scan(value) {
  if (value && typeof value === 'object') for (const child of Object.values(value)) scan(child);
  else if (typeof value === 'string') for (const token of forbidden) if (value.toLowerCase().includes(token)) errors.push(`forbidden physical field/API token in Definition: '${token}' near: ${value.slice(0, 80)}`);
}
for (const document of [pkg, wf, acts, roles, routes, arts, val, snapshot]) scan(document);

finish();
function finish() {
  if (errors.length) {
    console.error(`FAIL ${errors.length} checks:`);
    for (const error of errors) console.error(`  - ${error}`);
    process.exit(1);
  }
  console.log(`PASS: schema, graph/event, authority, corpus-shape and digest closure succeeded for ${ROOT}`);
}
