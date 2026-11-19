import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { Hex } from "effect/encoding";
import { generateTwitchOpenApi } from "./twitch-api.ts";

// Guards every generated OpenAPI field. Re-pinned for Effect 4.1.4, whose generator flattens nested `anyOf`
// unions and emits `Int`'s safe-integer bounds; the document is otherwise identical to the previous baseline.
const baselineOpenApiSha256 = "fec9f9974d885c586e3ee042c4ac1ff8397b1c6fee8e6481e542ef94bda140dd";

const openApiOperationMethods = new Set([
  "get",
  "put",
  "post",
  "delete",
  "options",
  "head",
  "patch",
  "trace",
]);

const countOpenApiOperations = (openApi: ReturnType<typeof generateTwitchOpenApi>): number =>
  Object.values(openApi.paths).reduce(
    (total, path) =>
      total + Object.keys(path).filter((method) => openApiOperationMethods.has(method)).length,
    0,
  );

const digestOpenApi = (openApi: ReturnType<typeof generateTwitchOpenApi>) =>
  Effect.promise(() =>
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(openApi))),
  ).pipe(Effect.map((digest) => Hex.encode(new Uint8Array(digest))));

it.effect("preserves the complete generated Twitch OpenAPI document", () =>
  Effect.gen(function* () {
    const openApi = generateTwitchOpenApi();

    expect(Object.keys(openApi.paths)).toHaveLength(38);
    expect(countOpenApiOperations(openApi)).toBe(40);
    expect(yield* digestOpenApi(openApi)).toBe(baselineOpenApiSha256);
  }),
);

it("preserves privileged query parameters alongside administrator security", () => {
  const openApi = generateTwitchOpenApi();
  const expectedSecurity = [{ AdministratorBearer: [] }];

  expect(openApi.components.securitySchemes).toEqual({
    AdministratorBearer: { type: "http", scheme: "bearer" },
    OAuthSetupHeader: { type: "apiKey", in: "header", name: "x-setup-secret" },
  });
  expect(openApi.paths["/api/admin/dlq"]?.get).toMatchObject({
    security: expectedSecurity,
    parameters: [
      { name: "limit", in: "query", required: false },
      { name: "offset", in: "query", required: false },
    ],
  });
  expect(openApi.paths["/api/admin/event-bus/pending"]?.get).toMatchObject({
    security: expectedSecurity,
    parameters: [
      { name: "limit", in: "query", required: false },
      { name: "offset", in: "query", required: false },
    ],
  });
  expect(openApi.paths["/api/debug/keyboard-raffle/leaderboard"]?.get).toMatchObject({
    security: expectedSecurity,
    parameters: [
      { name: "limit", in: "query", required: false },
      { name: "sortBy", in: "query", required: false },
    ],
  });
});
