import { EventSubReceiptStatus } from "@cf-twitch/contracts/eventsub";
import { EventSubMessageId } from "@cf-twitch/contracts/identity";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { Effect, Layer, Option, Redacted, Schema } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import { achievementsClientLayerWithoutDependencies } from "../../src/features/achievements/achievements-client.ts";
import { achievementsServerLayerWithoutDependencies } from "../../src/features/achievements/achievements-server.ts";
import { commandsClientLayerWithoutDependencies } from "../../src/features/commands/commands-client.ts";
import { computedChatCommandsLayerWithoutDependencies } from "../../src/features/commands/computed-chat-commands.ts";
import { commandsServerLayerWithoutDependencies } from "../../src/features/commands/commands-server.ts";
import { executorLayerWithoutDependencies } from "../../src/features/commands/chat-command-executor.ts";
import {
  eventBusAdministrationLayerWithoutDependencies,
  eventPublisherLayerWithoutDependencies,
} from "../../src/features/events/event-bus-client.ts";
import { eventBusServerLayerWithoutDependencies } from "../../src/features/events/event-bus-server.ts";
import { eventSubReceiptsLayerWithoutDependencies } from "../../src/features/eventsub/eventsub-client.ts";
import { EventSubReceipts } from "../../src/features/eventsub/eventsub-receipts.ts";
import { eventSubWebhookServerLayerWithoutDependencies } from "../../src/features/eventsub/eventsub-server.ts";
import { httpTestConfiguration } from "../../src/features/http/http-test-fixtures.ts";
import { oauthAuthorizationLayerWithoutDependencies } from "../../src/features/oauth/oauth-authorization.ts";
import { oauthStateClientLayerWithoutDependencies } from "../../src/features/oauth/oauth-state-client.ts";
import { oauthStateServerLayer } from "../../src/features/oauth/oauth-state-server.ts";
import {
  ProviderScenarioTranscript,
  providerScenarioTransportLayer,
} from "../../src/features/providers/provider-scenario-transport.test-support.ts";
import { ProviderAccessTokens } from "../../src/features/providers/provider-access-tokens.ts";
import { providerAccessTokensLayerWithoutDependencies } from "../../src/features/providers/provider-token-client.ts";
import { providerTokenExchangeLayerWithoutDependencies } from "../../src/features/providers/provider-token-exchange.ts";
import {
  spotifyTokenServerLayerWithoutDependencies,
  twitchTokenServerLayerWithoutDependencies,
} from "../../src/features/providers/provider-token-server.ts";
import { spotifyServiceLayerWithoutDependencies } from "../../src/features/providers/spotify-service.ts";
import { twitchServiceLayerWithoutDependencies } from "../../src/features/providers/twitch-service.ts";
import { raffleClientLayerWithoutDependencies } from "../../src/features/raffle/raffle-client.ts";
import { raffleServerLayer } from "../../src/features/raffle/raffle-server.ts";
import { songQueueClientLayerWithoutDependencies } from "../../src/features/song-queue/song-queue-client.ts";
import { songQueueServerLayerWithoutDependencies } from "../../src/features/song-queue/song-queue-server.ts";
import { streamLifecycleClientLayerWithoutDependencies } from "../../src/features/stream/stream-lifecycle-client.ts";
import { streamLifecycleServerLayerWithoutDependencies } from "../../src/features/stream/stream-server.ts";
import { workflowStartersLayerWithoutDependencies } from "../../src/features/workflows/workflow-client.ts";
import {
  keyboardRaffleSagaServerLayerWithoutDependencies,
  raidShoutoutSagaServerLayerWithoutDependencies,
  songRequestSagaServerLayerWithoutDependencies,
} from "../../src/features/workflows/workflow-server.ts";
import {
  TwitchApiWorker,
  twitchWorkerImplementationWithoutDependencies,
} from "../../src/runtime/twitch-worker.ts";
import { TwitchConfiguration } from "../../src/runtime/twitch-configuration.ts";
import { twitchHttpTelemetrySafetyLayer } from "../../src/runtime/twitch-telemetry.ts";
import { recordingTwitchAnalyticsLayer } from "../support/recording-twitch-analytics.ts";

const parseScenarioEventSubMessageId = Schema.decodeUnknownEffect(EventSubMessageId);
const ScenarioEventSubReceiptStatus = Schema.OptionFromNullOr(EventSubReceiptStatus);
const encodeScenarioEventSubReceiptStatus = Schema.encodeEffect(ScenarioEventSubReceiptStatus);

const configurationLayer = Layer.succeed(TwitchConfiguration, httpTestConfiguration);
const controlledPlatformLayer = Layer.mergeAll(
  configurationLayer,
  providerScenarioTransportLayer,
  recordingTwitchAnalyticsLayer,
  NodeCrypto.layer,
);

const providerTokenExchangeLayer = providerTokenExchangeLayerWithoutDependencies.pipe(
  Layer.provide(controlledPlatformLayer),
);
const providerTokenServersLayer = Layer.mergeAll(
  spotifyTokenServerLayerWithoutDependencies,
  twitchTokenServerLayerWithoutDependencies,
).pipe(Layer.provide(providerTokenExchangeLayer));
const providerAccessTokensLayer = providerAccessTokensLayerWithoutDependencies.pipe(
  Layer.provide(providerTokenServersLayer),
);
const spotifyServiceLayer = spotifyServiceLayerWithoutDependencies.pipe(
  Layer.provide([controlledPlatformLayer, providerAccessTokensLayer]),
);
const twitchServiceLayer = twitchServiceLayerWithoutDependencies.pipe(
  Layer.provide([controlledPlatformLayer, providerAccessTokensLayer, providerTokenExchangeLayer]),
);

const achievementsServerLayer = achievementsServerLayerWithoutDependencies.pipe(
  Layer.provide([twitchServiceLayer, recordingTwitchAnalyticsLayer]),
);
const achievementsLayer = achievementsClientLayerWithoutDependencies.pipe(
  Layer.provide(achievementsServerLayer),
);
const commandsLayer = commandsClientLayerWithoutDependencies.pipe(
  Layer.provide(commandsServerLayerWithoutDependencies),
);
const raffleLayer = raffleClientLayerWithoutDependencies.pipe(Layer.provide(raffleServerLayer));
const songQueueServerLayer = songQueueServerLayerWithoutDependencies.pipe(
  Layer.provide(spotifyServiceLayer),
);
const songQueueLayer = songQueueClientLayerWithoutDependencies.pipe(
  Layer.provide(songQueueServerLayer),
);

const eventBusServerLayer = eventBusServerLayerWithoutDependencies.pipe(
  Layer.provide(achievementsLayer),
);
const eventPublisherLayer = eventPublisherLayerWithoutDependencies.pipe(
  Layer.provide(eventBusServerLayer),
);
const eventBusAdministrationLayer = eventBusAdministrationLayerWithoutDependencies.pipe(
  Layer.provide(eventBusServerLayer),
);
const streamServerLayer = streamLifecycleServerLayerWithoutDependencies.pipe(
  Layer.provide([
    providerAccessTokensLayer,
    eventPublisherLayer,
    twitchServiceLayer,
    configurationLayer,
  ]),
);
const streamLayer = streamLifecycleClientLayerWithoutDependencies.pipe(
  Layer.provide(streamServerLayer),
);

const workflowDependenciesLayer = Layer.mergeAll(
  spotifyServiceLayer,
  twitchServiceLayer,
  songQueueLayer,
  raffleLayer,
  eventPublisherLayer,
  recordingTwitchAnalyticsLayer,
  NodeCrypto.layer,
);
const workflowServersLayer = Layer.mergeAll(
  songRequestSagaServerLayerWithoutDependencies,
  keyboardRaffleSagaServerLayerWithoutDependencies,
  raidShoutoutSagaServerLayerWithoutDependencies,
).pipe(Layer.provide(workflowDependenciesLayer));
const workflowStartersLayer = workflowStartersLayerWithoutDependencies.pipe(
  Layer.provide(workflowServersLayer),
);
const computedCommandsLayer = computedChatCommandsLayerWithoutDependencies.pipe(
  Layer.provide([commandsLayer, songQueueLayer, raffleLayer, achievementsLayer]),
);
const commandExecutorLayer = executorLayerWithoutDependencies.pipe(
  Layer.provide([commandsLayer, computedCommandsLayer, recordingTwitchAnalyticsLayer]),
);
const eventSubServerLayer = eventSubWebhookServerLayerWithoutDependencies.pipe(
  Layer.provide([
    workflowStartersLayer,
    twitchServiceLayer,
    streamLayer,
    commandExecutorLayer,
    configurationLayer,
    recordingTwitchAnalyticsLayer,
  ]),
);
const eventSubReceiptsLayer = eventSubReceiptsLayerWithoutDependencies.pipe(
  Layer.provide(eventSubServerLayer),
);

const oauthStateLayer = oauthStateClientLayerWithoutDependencies.pipe(
  Layer.provide(oauthStateServerLayer),
);
const oauthAuthorizationLayer = oauthAuthorizationLayerWithoutDependencies.pipe(
  Layer.provide([
    oauthStateLayer,
    providerAccessTokensLayer,
    providerTokenExchangeLayer,
    configurationLayer,
    NodeCrypto.layer,
  ]),
);

const fullWorkerApplicationLayer = Layer.mergeAll(
  achievementsLayer,
  commandsLayer,
  eventBusAdministrationLayer,
  eventSubReceiptsLayer,
  oauthAuthorizationLayer,
  raffleLayer,
  songQueueLayer,
  streamLayer,
  twitchServiceLayer,
  providerAccessTokensLayer,
  providerScenarioTransportLayer,
  configurationLayer,
);

const fullWorkerScenarioImplementation = Effect.gen(function* () {
  const application = yield* twitchWorkerImplementationWithoutDependencies;
  const accessTokens = yield* ProviderAccessTokens;
  const eventSubReceipts = yield* EventSubReceipts;
  const transcript = yield* ProviderScenarioTranscript;
  const fetch = Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const pathname = new URL(request.originalUrl).pathname;
    if (pathname === "/__scenario/provider-transcript")
      return HttpServerResponse.jsonUnsafe({ requests: yield* transcript.readRequests() });
    if (pathname === "/__scenario/eventsub-receipt-status") {
      const messageId = yield* parseScenarioEventSubMessageId(
        new URL(request.originalUrl).searchParams.get("messageId"),
      );
      const status = yield* eventSubReceipts.getReceiptStatus(messageId);
      const encodedStatus = yield* encodeScenarioEventSubReceiptStatus(status);
      return HttpServerResponse.jsonUnsafe(encodedStatus);
    }
    if (pathname !== "/__scenario/provider-token/concurrent-refresh")
      return yield* application.fetch;

    yield* accessTokens.setTokens({
      provider: "spotify",
      tokens: {
        accessToken: Redacted.make("scenario:normal"),
        refreshToken: Option.some(Redacted.make("scenario-refresh")),
        tokenType: "Bearer",
        // The five-minute safety buffer becomes active after this short controlled delay.
        expiresIn: 300.2,
        scopes: ["user-read-playback-state"],
      },
    });
    yield* accessTokens.onStreamOnline("spotify");
    yield* Effect.sleep("300 millis");
    const concurrent = yield* Effect.all(
      [accessTokens.getValidAccessToken("spotify"), accessTokens.getValidAccessToken("spotify")],
      { concurrency: "unbounded" },
    );
    const committed = yield* accessTokens.getValidAccessToken("spotify");
    const values = concurrent.map(Redacted.value);
    return HttpServerResponse.jsonUnsafe({
      concurrentCallersConverged: values[0] === values[1],
      callersReturnedCommittedToken: values.every((value) => value === Redacted.value(committed)),
    });
  }).pipe(
    Effect.catchTags({
      EventSubReceiptError: Effect.die,
      ProviderError: Effect.die,
      SchemaError: Effect.die,
    }),
  );
  return { fetch };
});

/** Fresh local Worker with all thirteen production Durable Object classes and controlled providers. */
export const fullWorkerScenarioLayer = TwitchApiWorker.make(
  {
    main: import.meta.url,
    compatibility: { date: "2026-09-08", flags: ["nodejs_compat"] },
    dev: { host: "127.0.0.1", port: 8798, strictPort: true },
    workersDev: true,
  },
  fullWorkerScenarioImplementation.pipe(
    Effect.provide(fullWorkerApplicationLayer),
    Effect.provide(NodeCrypto.layer),
    Effect.orDie,
  ),
).pipe(Layer.provideMerge(twitchHttpTelemetrySafetyLayer));

/** Deployable full-graph scenario output contains only its isolated local URL. */
export const fullWorkerScenarioStack = Effect.gen(function* () {
  const worker = yield* TwitchApiWorker;
  if (worker.url === undefined) return yield* Effect.die("Full Worker scenario URL is unavailable");
  return { url: worker.url };
}).pipe(Effect.provide(fullWorkerScenarioLayer));

export default fullWorkerScenarioLayer;
