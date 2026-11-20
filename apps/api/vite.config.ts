import { defineConfig } from "vite-plus";

/** Vite+ configuration that separates ordinary tests from explicitly staged local-workerd acceptance tests. */
export default defineConfig(({ mode }) => ({
  run: {
    tasks: {
      "test:e2e:local": {
        cache: false,
        command: "node scripts/run-e2e.ts local",
      },
    },
  },
  test:
    mode === "e2e"
      ? {
          include: ["src/**/scenario/*.workerd.ts", "test/e2e.test.ts"],
          testTimeout: 120_000,
          hookTimeout: 120_000,
        }
      : {
          include: ["src/**/*.test.ts", "test/review/**/*.test.ts", "test/support/**/*.test.ts"],
        },
}));
