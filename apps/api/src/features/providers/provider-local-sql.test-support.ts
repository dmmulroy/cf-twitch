import { SqliteClient } from "@effect/sql-sqlite-node";
import { NodeCrypto } from "@effect/platform-node";
import { BroadcasterId, RewardId } from "@cf-twitch/contracts/identity";
import { ProviderError, type OAuthProvider } from "@cf-twitch/contracts/provider";
import { Context, Effect, Layer, Option, Redacted } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { TwitchConfiguration } from "../../runtime/twitch-configuration.ts";
import { ProviderAccessTokens } from "./provider-access-tokens.ts";
import {
  TokenProviderIdentity,
  providerTokenDatabaseLayerWithoutDependencies,
} from "./provider-token-database.ts";
import { providerTokenExchangeLayer } from "./provider-token-exchange.ts";
import {
  ProviderTokenAlarm,
  ProviderTokenLifecycle,
  providerTokenLifecycleLayerWithoutDependencies,
} from "./provider-token-lifecycle.ts";

/** Fixture configuration contains only synthetic local credentials and never reads environment secrets. */
export const providerLocalConfigurationLayer = Layer.succeed(TwitchConfiguration, {
  twitch: {
    clientId: "twitch-client",
    clientSecret: Redacted.make("twitch-secret"),
    broadcaster: { id: BroadcasterId.make("123"), displayName: "Test" },
  },
  spotify: { clientId: "spotify-client", clientSecret: Redacted.make("spotify-secret") },
  eventSubSecret: Redacted.make("eventsub-secret"),
  oauthSetupSecret: Redacted.make("setup-secret"),
  administratorSecret: Redacted.make("admin-secret"),
  rewardRouting: {
    songRequestRewardId: RewardId.make("song"),
    keyboardRaffleRewardId: RewardId.make("raffle"),
  },
});

// A real SQLite alarm register implements set/delete durably. Native alarm dispatch is
// deliberately driven through refreshTokenTick in tests; workerd tests cover native dispatch.
const sqliteAlarmLayer = Layer.effect(
  ProviderTokenAlarm,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const provider = yield* TokenProviderIdentity;
    const failure = () =>
      new ProviderError({
        provider,
        operation: "localSqliteAlarm",
        kind: "persistence",
        status: 0,
        retryAfterMs: Option.none(),
      });
    yield* sql`CREATE TABLE IF NOT EXISTS local_token_alarm (singleton INTEGER PRIMARY KEY CHECK(singleton = 1), due_at_ms INTEGER NOT NULL)`.pipe(
      Effect.mapError(failure),
    );
    return ProviderTokenAlarm.of({
      setAlarm: Effect.fn("LocalSqliteTokenAlarm.setAlarm")((atMs) =>
        sql`INSERT INTO local_token_alarm VALUES(1, ${atMs}) ON CONFLICT(singleton) DO UPDATE SET due_at_ms = excluded.due_at_ms`.pipe(
          Effect.asVoid,
          Effect.mapError(failure),
        ),
      ),
      deleteAlarm: Effect.fn("LocalSqliteTokenAlarm.deleteAlarm")(() =>
        sql`DELETE FROM local_token_alarm`.pipe(Effect.asVoid, Effect.mapError(failure)),
      ),
    });
  }),
);

/** Local token lifecycle uses real SQLite for credentials and alarm intent, with HTTP exchange left injectable. */
export const providerLocalTokenLayer = (provider: OAuthProvider) => {
  const sqlite = SqliteClient.layer({ filename: ":memory:" });
  const resources = Layer.mergeAll(
    providerTokenDatabaseLayerWithoutDependencies,
    sqliteAlarmLayer,
  ).pipe(Layer.provide(Layer.succeed(TokenProviderIdentity, provider)), Layer.provideMerge(sqlite));
  return providerTokenLifecycleLayerWithoutDependencies.pipe(
    Layer.provideMerge(resources),
    Layer.provide(Layer.succeed(TokenProviderIdentity, provider)),
    Layer.provide(providerTokenExchangeLayer),
  );
};

/** Full local access-token implementation delegates each provider to a distinct real SQL token lifecycle. */
export const providerLocalAccessTokensLayer = Layer.effect(
  ProviderAccessTokens,
  Effect.gen(function* () {
    const spotify = Context.get(
      yield* Layer.build(providerLocalTokenLayer("spotify")),
      ProviderTokenLifecycle,
    );
    const twitch = Context.get(
      yield* Layer.build(providerLocalTokenLayer("twitch")),
      ProviderTokenLifecycle,
    );
    const lifecycle = (provider: OAuthProvider) => (provider === "spotify" ? spotify : twitch);
    return ProviderAccessTokens.of({
      getValidAccessToken: Effect.fn("LocalProviderAccessTokens.getValidAccessToken")((provider) =>
        lifecycle(provider).getValidToken(),
      ),
      setTokens: Effect.fn("LocalProviderAccessTokens.setTokens")((input) =>
        lifecycle(input.provider).setTokens(input.tokens),
      ),
      onStreamOnline: Effect.fn("LocalProviderAccessTokens.onStreamOnline")((provider) =>
        lifecycle(provider).onStreamOnline(),
      ),
      onStreamOffline: Effect.fn("LocalProviderAccessTokens.onStreamOffline")((provider) =>
        lifecycle(provider).onStreamOffline(),
      ),
    });
  }),
);

/** Platform crypto in tests uses Node's real secure random implementation. */
export const providerLocalCryptoLayer = NodeCrypto.layer;
