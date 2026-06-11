import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // test/ holds node-env unit tests; convex/*.test.ts holds convex-test
    // integration tests (they opt into edge-runtime per-file via a docblock).
    include: ["test/**/*.test.ts", "convex/**/*.test.ts"],
    environment: "node",
    testTimeout: 10000,
    setupFiles: ["test/setup.ts"],
  },
});
