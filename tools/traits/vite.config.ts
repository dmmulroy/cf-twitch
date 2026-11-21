import { defineConfig } from "vite-plus";

/**
 * Vite+ configuration for Traits tooling, which runs the Claude subscription language model tests.
 *
 * **Details**
 *
 * The Traits configuration itself is re-exported by the root `traits.ts`, where Traits looks for
 * it. `pnpm test:unit` runs these tests.
 */
export default defineConfig({});
