import decoratorsPlugin from "@babel/plugin-proposal-decorators";
import babel from "@rolldown/plugin-babel";

import type { Plugin } from "vite";

/** Transforms TC39 decorators until Vite's Oxc transform supports them. */
export function decorators(): Plugin {
	// SAFETY: Rolldown's plugin contract is the plugin contract consumed by Vite 8.
	return babel({
		presets: [
			{
				preset: () => ({
					plugins: [[decoratorsPlugin, { version: "2023-11" }]],
				}),
				rolldown: {
					filter: { code: "@" },
				},
			},
		],
	}) as unknown as Plugin;
}
