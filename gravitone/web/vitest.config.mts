import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

// The web app had no test runner at all: everything shipped on `tsc --noEmit`,
// which proves types and nothing about behaviour. The honesty conventions in
// .claude/CLAUDE.md (never claim success on failure, always surface a failed
// request, guard state after await) are exactly the kind of rule a type
// checker cannot enforce — so they get tests instead.
export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    globals: true,
    include: ["{app,lib,components}/**/*.test.{ts,tsx}"],
    setupFiles: ["./vitest.setup.ts"],
    restoreMocks: true,
  },
  // tsconfig says jsx:"preserve" (Next compiles it), so esbuild would fall
  // back to the classic runtime and every .tsx test would need React in scope.
  esbuild: { jsx: "automatic" },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./", import.meta.url)),
    },
  },
});
