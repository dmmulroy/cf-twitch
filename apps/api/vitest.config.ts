import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vite-plus";

import { decorators } from "./vite-plugin-decorator-transform";

export default defineConfig({
	plugins: [
		decorators(),
		cloudflareTest({
			main: "./src/index.ts",
			wrangler: { configPath: "./wrangler.test.jsonc" },
			miniflare: {
				kvPersist: false,
				d1Persist: false,
				r2Persist: false,
			},
		}),
	],
	test: {
		setupFiles: ["./src/__tests__/setup.ts"],
	},
});
