import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

interface Schema { readonly $defs?: Record<string, unknown>; readonly properties: Record<string, any> }
const root = fileURLToPath(new URL("..", import.meta.url));
const contractRoot = path.resolve(root, "../system-contracts/workflow-dsl-2-candidate/generated/schemas");
const meta = JSON.parse(readFileSync(path.join(contractRoot, "agentops.meta.schema.json"), "utf8")) as { $defs: { contractVersion: { const: string } } };
const routes = JSON.parse(readFileSync(path.join(contractRoot, "routes.schema.json"), "utf8")) as Schema;
const workflow = JSON.parse(readFileSync(path.join(contractRoot, "workflow-definition.schema.json"), "utf8")) as Schema;
const provider = routes.properties.routes.items.properties.resources.properties.capabilities.items.enum as readonly string[];
const host = workflow.properties.hostOperations.items.properties.requiredCapabilities.items.enum as readonly string[];
const union = (values: readonly string[]) => values.map(value => JSON.stringify(value)).join(" | ");
const template = readFileSync(path.join(root, "scripts/templates/workflow-contract.ts.txt"), "utf8");
const rendered = template
  .replace("{{CONTRACT_VERSION}}", meta.$defs.contractVersion.const)
  .replace("{{PROVIDER_CAPABILITIES}}", union(provider))
  .replace("{{HOST_CAPABILITIES}}", union(host));
const output = path.join(root, "src/contracts/generated/workflow-contract.ts");

const frozenWorkflowDslFiles = [
  "schemas/actions.schema.json",
  "schemas/agentops.meta.schema.json",
  "schemas/artifacts.schema.json",
  "schemas/package-snapshot.schema.json",
  "schemas/package.schema.json",
  "schemas/roles.schema.json",
  "schemas/routes.schema.json",
  "schemas/validation.schema.json",
  "schemas/workflow-definition.schema.json",
  "tools/canonicalize.cjs",
  "tools/check-example.cjs",
] as const;
const generatedWorkflowDslV2Root = path.join(root, "config/workflow-dsl-v2-candidate");

function synchronizeFrozenWorkflowDsl(check: boolean, sourceRoot = path.resolve(contractRoot, ".."), destinationRoot = generatedWorkflowDslV2Root): void {
  for (const relative of frozenWorkflowDslFiles) {
    const source = path.resolve(sourceRoot, relative);
    const destination = path.join(destinationRoot, relative);
    const bytes = readFileSync(source);
    if (check) {
      if (!readFileSync(destination).equals(bytes)) throw new Error(`generated Workflow DSL validator is stale: ${relative}`);
    } else {
      mkdirSync(path.dirname(destination), { recursive: true });
      writeFileSync(destination, bytes);
    }
  }
}

if (process.argv.includes("--check")) {
  if (readFileSync(output, "utf8") !== rendered) throw new Error("generated Workflow Contract projection is stale");
  synchronizeFrozenWorkflowDsl(true);
} else {
  writeFileSync(output, rendered);
  synchronizeFrozenWorkflowDsl(false);
}
