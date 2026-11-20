import { defineConfig } from "vite-plus";

/**
 * Vite config for Traits tooling: the Traits configuration (re-exported by the root `traits.ts`,
 * where Traits looks for it) and the Claude subscription language model. `pnpm test:unit` runs its
 * tests.
 */
const toolsTraitsViteConfig = defineConfig({});

export default toolsTraitsViteConfig;
