import { expect, it } from "@effect/vitest";
import { Effect, Option, Schema } from "effect";
import { Hex } from "effect/encoding";
import { TwitchHttpErrorBody, generateTwitchOpenApi } from "./twitch-api.ts";

// Guards every generated OpenAPI field. Re-pinned when public errors became the discriminated
// `TwitchHttpErrorBody` union under statuses 400/401/404/409/500/503; paths and operations are unchanged.
const baselineOpenApiSha256 = "5a88c344d783c2efa689ac828dbb84e831bb8079fc770aebf424b21b8a41c7c0";

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

it("declares public errors only under statuses that carry caller meaning", () => {
  const responses = generateTwitchOpenApi().paths["/api/queue"]?.get?.responses ?? {};

  expect(Object.keys(responses).sort()).toEqual(["200", "400", "401", "404", "409", "500", "503"]);
});

it("keeps every public error code unique so the code alone selects its details schema", () => {
  const codes = TwitchHttpErrorBody.members.map((member) => member.fields.code.literal);

  expect(new Set(codes).size).toBe(codes.length);
});

it("encodes Option-valued error details into their nullable wire form", () => {
  const encoded = Schema.encodeSync(TwitchHttpErrorBody)({
    code: "StreamReconciliationUnconfirmed",
    error: "Reconciliation completed but failed to read final state",
    operation: "reconcileStream",
    message: "Stream reconciliation unconfirmed: read the stream state.",
    details: {
      action: "noop",
      before: {
        isLive: false,
        startedAt: Option.none(),
        endedAt: Option.none(),
        peakViewerCount: 0,
      },
    },
    requestId: "00000000-0000-4000-8000-000000000000",
    retryable: false,
  });

  expect(encoded.details).toEqual({
    action: "noop",
    before: { isLive: false, startedAt: null, endedAt: null, peakViewerCount: 0 },
  });
});
