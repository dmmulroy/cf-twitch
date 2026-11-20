import { generateTwitchOpenApi } from "@cf-twitch/contracts/twitch-api";
import { NodeRuntime } from "@effect/platform-node";
import { Effect } from "effect";

/**
 * Effect that prints the canonical route list and OpenAPI document without starting runtime services.
 *
 * **Details**
 *
 * With `--check`, prints only the OpenAPI version and path count.
 *
 * @throws A defect when OpenAPI generation throws for an invalid API definition.
 */
export const inspectCfTwitchApi = Effect.sync(() => {
  const openApi = generateTwitchOpenApi();

  const inspection = {
    paths: Object.keys(openApi.paths).sort(),
    openApi,
  };

  const output = process.argv.includes("--check")
    ? `CF Twitch OpenAPI ${openApi.openapi}: ${inspection.paths.length} paths\n`
    : `${JSON.stringify(inspection, null, 2)}\n`;

  process.stdout.write(output);
});

if (import.meta.main) {
  NodeRuntime.runMain(inspectCfTwitchApi);
}
