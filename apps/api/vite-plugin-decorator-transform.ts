import decoratorsPlugin from "@babel/plugin-proposal-decorators";
import babel from "@rolldown/plugin-babel";

/** Transforms TC39 decorators until Vite's Oxc transform supports them. */
export function decorators() {
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
	});
}
