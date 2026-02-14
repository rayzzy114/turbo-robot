import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: [
      { find: /^@\//, replacement: `${path.resolve(__dirname, "admin/src")}/` },
    ],
  },
  test: {
    environment: "node",
    globals: true,
    setupFiles: ["./test/vitest.setup.ts"],
    include: ["test/**/*.test.ts"]
  }
});
