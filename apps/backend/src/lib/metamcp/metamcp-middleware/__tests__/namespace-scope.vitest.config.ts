import path from "node:path";

import { defineConfig } from "vitest/config";

export default defineConfig({
  envDir: false,
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "../../../..") } },
  test: {
    environment: "node",
    include: [
      "src/lib/metamcp/metamcp-middleware/__tests__/namespace-scope.test.ts",
      "src/lib/metamcp/metamcp-middleware/audit-requests.functional.test.ts",
    ],
  },
});
