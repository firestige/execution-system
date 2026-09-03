import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
      include: ["src/**/*.ts", "scripts/**/*.ts"],
      exclude: [
        "scripts/generate-workflow-contract.ts",
        "scripts/generate-changelog.ts",
        "scripts/build-release-artifacts.ts",
        "scripts/build-workflow-release-assets.ts",
        "scripts/benchmark-managed-workspace-snapshot.ts",
        "scripts/qualify-current-source-browser.ts",
        "scripts/qualify-dsh-product-e2e.ts",
        "scripts/serve-workflow-assets.ts",
        "scripts/verify-iteration-3-documentation.ts",
      ],
      thresholds: {
        statements: 90,
        branches: 85,
        functions: 90,
        lines: 90,
      },
    },
  },
});
