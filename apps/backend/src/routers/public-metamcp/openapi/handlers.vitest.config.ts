import path from "node:path";

import { defineConfig } from "vitest/config";

export default defineConfig({
  envDir: false,
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "../../..") } },
  test: {
    environment: "node",
    include: ["src/routers/public-metamcp/openapi/handlers.test.ts"],
  },
});
