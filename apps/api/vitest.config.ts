import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
	test: {
		poolOptions: {
			workers: {
				main: "./src/index.ts",
				wrangler: { configPath: "./wrangler.test.jsonc" },
				miniflare: {
					kvPersist: false,
					d1Persist: false,
					r2Persist: false,
				},
			},
		},
		setupFiles: ["./src/__tests__/setup.ts"],
	},
});
