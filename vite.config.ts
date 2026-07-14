import { defineConfig } from "vite-plus";

export default defineConfig({
	lint: {
		plugins: ["typescript", "import", "promise"],
		jsPlugins: [
			{ name: "local", specifier: "./tools/oxlint-rules/no-dynamic-import.cjs" },
			{ name: "vite-plus", specifier: "vite-plus/oxlint-plugin" },
		],
		env: {
			browser: true,
			es2024: true,
		},
		globals: {
			DurableObject: "readonly",
			DurableObjectState: "readonly",
			DurableObjectId: "readonly",
			DurableObjectNamespace: "readonly",
			DurableObjectStub: "readonly",
			DurableObjectStorage: "readonly",
			Workflow: "readonly",
			Queue: "readonly",
			AnalyticsEngineDataset: "readonly",
			VectorizeIndex: "readonly",
			Ai: "readonly",
			Fetcher: "readonly",
			ExportedHandlerQueueHandler: "readonly",
			Rpc: "readonly",
		},
		rules: {
			"no-console": "warn",
			"typescript/no-explicit-any": "error",
			"typescript/no-non-null-assertion": "error",
			"import/no-cycle": "error",
			"local/no-dynamic-import": "error",
			"vite-plus/prefer-vite-plus-imports": "error",
		},
		overrides: [
			{
				files: ["**/logger.ts"],
				rules: {
					"no-console": "off",
				},
			},
		],
		ignorePatterns: [
			"node_modules",
			"dist",
			"*.d.ts",
			"opensrc",
			".pi",
			".pi/**",
			"**/drizzle/**/migrations.js",
		],
		// tsgolint currently mis-types TC39-decorated Durable Object classes.
		// Keep `tsc --noEmit` as the project type-check until that limitation is fixed.
		options: { typeAware: false, typeCheck: false },
	},
	test: {
		projects: ["apps/*"],
	},
	fmt: {
		useTabs: true,
		tabWidth: 2,
		printWidth: 100,
		semi: true,
		singleQuote: false,
		trailingComma: "all",
		bracketSpacing: true,
		arrowParens: "always",
		endOfLine: "lf",
		experimentalSortImports: {
			order: "asc",
			ignoreCase: true,
			newlinesBetween: true,
			groups: [["builtin", "external"], ["internal"], ["parent", "sibling", "index"], ["type"]],
			internalPattern: ["~/**", "@/**"],
		},
		ignorePatterns: [
			"node_modules",
			"dist",
			"*.d.ts",
			"opensrc",
			".pi",
			".pi/**",
			"pnpm-lock.yaml",
		],
	},
});
