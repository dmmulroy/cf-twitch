import { expectTypeOf, it } from "@effect/vitest";
import type * as Cloudflare from "@alchemy.run/cloudflare";
import type { Layer, Scope } from "effect";
import type { Digest, SecureRandom } from "effect/crypto";
import type { HttpClient } from "effect/http";
import type { SqlClient } from "effect/sql";
import type { ProviderTokenIdentity } from "../features/providers/provider-token-identity.ts";
import type { achievementsServerLayerWithoutDependencies } from "../features/achievements/achievements-server.ts";
import type { commandsServerLayerWithoutDependencies } from "../features/commands/commands-server.ts";
import type { eventBusServerLayerWithoutDependencies } from "../features/events/event-bus-server.ts";
import type { eventSubWebhookServerLayerWithoutDependencies } from "../features/eventsub/eventsub-server.ts";
import type { oauthStateServerLayer } from "../features/oauth/oauth-state-server.ts";
import type { spotifyTokenServerLayerWithoutDependencies } from "../features/providers/provider-token-server.ts";
import type { raffleServerLayer } from "../features/raffle/raffle-server.ts";
import type { songQueueServerLayerWithoutDependencies } from "../features/song-queue/song-queue-server.ts";
import type { streamLifecycleServerLayerWithoutDependencies } from "../features/stream/stream-server.ts";
import type { songRequestSagaServerLayerWithoutDependencies } from "../features/workflows/workflow-server.ts";
import type { twitchApiWorkerLayer } from "./twitch-worker.ts";
import type { achievementOutboxTestLayer } from "../features/achievements/achievement-outbox.ts";
import type { achievementsTestLayer } from "../features/achievements/achievements-service.ts";
import type { chatCommandExecutorTestLayer } from "../features/commands/chat-command-executor.ts";
import type { commandsSnapshotStoreTestLayer } from "../features/commands/commands-snapshot-store.ts";
import type { commandsTestLayer } from "../features/commands/commands.ts";
import type { computedChatCommandsTestLayer } from "../features/commands/computed-chat-commands.ts";
import type { eventBusAdministrationTestLayer } from "../features/events/event-bus-administration.ts";
import type { eventBusAlarmTestLayer } from "../features/events/event-bus-alarm.ts";
import type { eventBusDatabaseTestLayer } from "../features/events/event-bus-database.ts";
import type { eventBusTestLayer } from "../features/events/event-bus.ts";
import type { eventHandlerTestLayer } from "../features/events/event-handler.ts";
import type { eventPublisherTestLayer } from "../features/events/event-publisher.ts";
import type { eventSubDispatchTestLayer } from "../features/eventsub/eventsub-dispatch.ts";
import type { eventSubInboxTestLayer } from "../features/eventsub/eventsub-inbox.ts";
import type { eventSubReceiptsTestLayer } from "../features/eventsub/eventsub-receipts.ts";
import type { httpRequestCorrelationTestLayer } from "../features/http/http-request-correlation.ts";
import type { httpResponseCacheTestLayer } from "../features/http/http-response-cache.ts";
import type { oauthAuthorizationTestLayer } from "../features/oauth/oauth-authorization.ts";
import type { oauthStateClientTestLayer } from "../features/oauth/oauth-state-client.ts";
import type { oauthStateStoreTestLayer } from "../features/oauth/oauth-state-store.ts";
import type { providerAccessTokensTestLayer } from "../features/providers/provider-access-tokens.ts";
import type { providerTokenAlarmTestLayer } from "../features/providers/provider-token-alarm.ts";
import type { providerTokenDatabaseTestLayer } from "../features/providers/provider-token-database.ts";
import type { providerTokenExchangeTestLayer } from "../features/providers/provider-token-exchange.ts";
import type { providerTokenLifecycleTestLayer } from "../features/providers/provider-token-lifecycle.ts";
import type { raffleRandomTestLayer } from "../features/raffle/raffle-random.ts";
import type { raffleTestLayer } from "../features/raffle/raffle-service.ts";
import type { songQueueAlarmTestLayer } from "../features/song-queue/song-queue-alarm.ts";
import type { songQueueCoordinatorTestLayer } from "../features/song-queue/song-queue-coordinator.ts";
import type { songQueueDatabaseTestLayer } from "../features/song-queue/song-queue-database.ts";
import type { songQueueTestLayer } from "../features/song-queue/song-queue.ts";
import type { spotifyServiceTestLayer } from "../features/providers/spotify-service.ts";
import type { streamAlarmTestLayer } from "../features/stream/stream-alarm.ts";
import type { streamDatabaseTestLayer } from "../features/stream/stream-database.ts";
import type { streamLifecycleClientTestLayer } from "../features/stream/stream-lifecycle-client.ts";
import type { streamLifecycleTestLayer } from "../features/stream/stream-lifecycle.ts";
import type { streamViewerProviderTestLayer } from "../features/stream/stream-viewer-provider.ts";
import type { twitchAnalyticsTestLayer } from "./twitch-analytics.ts";
import type { twitchConfigurationTestLayer } from "./twitch-configuration.ts";
import type { twitchServiceTestLayer } from "../features/providers/twitch-service.ts";
import type { workflowAlarmTestLayer } from "../features/workflows/workflow-alarm.ts";
import type { workflowExecutionTestLayer } from "../features/workflows/workflow-execution.ts";
import type { workflowJournalTestLayer } from "../features/workflows/workflow-journal.ts";
import type { workflowStartersTestLayer } from "../features/workflows/workflow-starters.ts";

type RuntimeOnlyRequirement = Cloudflare.DurableObjectState | Scope.Scope;

// Alchemy beta.87 treats Digest and SecureRandom as Worker platform services: its workerd bridge provides them.
it("leaves platform cryptography to the Alchemy Worker platform without leaking it into the Stack", () => {
  expectTypeOf<
    Extract<Layer.Services<typeof raffleServerLayer>, SecureRandom.SecureRandom>
  >().toEqualTypeOf<never>();
  expectTypeOf<
    Extract<Layer.Services<typeof streamLifecycleServerLayerWithoutDependencies>, Digest.Digest>
  >().toEqualTypeOf<never>();
  expectTypeOf<
    Extract<Layer.Services<typeof twitchApiWorkerLayer>, Digest.Digest | SecureRandom.SecureRandom>
  >().toEqualTypeOf<never>();
});

it("keeps Durable Object storage and invocation scopes out of planning requirements", () => {
  expectTypeOf<
    Extract<
      Layer.Services<typeof achievementsServerLayerWithoutDependencies>,
      RuntimeOnlyRequirement
    >
  >().toEqualTypeOf<never>();
  expectTypeOf<
    Extract<Layer.Services<typeof commandsServerLayerWithoutDependencies>, RuntimeOnlyRequirement>
  >().toEqualTypeOf<never>();
  expectTypeOf<
    Extract<Layer.Services<typeof eventBusServerLayerWithoutDependencies>, RuntimeOnlyRequirement>
  >().toEqualTypeOf<never>();
  expectTypeOf<
    Extract<
      Layer.Services<typeof eventSubWebhookServerLayerWithoutDependencies>,
      RuntimeOnlyRequirement
    >
  >().toEqualTypeOf<never>();
  expectTypeOf<
    Extract<Layer.Services<typeof oauthStateServerLayer>, RuntimeOnlyRequirement>
  >().toEqualTypeOf<never>();
  expectTypeOf<
    Extract<
      Layer.Services<typeof spotifyTokenServerLayerWithoutDependencies>,
      RuntimeOnlyRequirement
    >
  >().toEqualTypeOf<never>();
  expectTypeOf<
    Extract<Layer.Services<typeof raffleServerLayer>, RuntimeOnlyRequirement>
  >().toEqualTypeOf<never>();
  expectTypeOf<
    Extract<Layer.Services<typeof songQueueServerLayerWithoutDependencies>, RuntimeOnlyRequirement>
  >().toEqualTypeOf<never>();
  expectTypeOf<
    Extract<
      Layer.Services<typeof streamLifecycleServerLayerWithoutDependencies>,
      RuntimeOnlyRequirement
    >
  >().toEqualTypeOf<never>();
  expectTypeOf<
    Extract<
      Layer.Services<typeof songRequestSagaServerLayerWithoutDependencies>,
      RuntimeOnlyRequirement
    >
  >().toEqualTypeOf<never>();
  expectTypeOf<
    Extract<Layer.Services<typeof twitchApiWorkerLayer>, RuntimeOnlyRequirement>
  >().toEqualTypeOf<never>();
});

/**
 * Requirements a service test Layer may leave for the test to select: platform services, plus the
 * token Durable Object identity that its physical server supplies.
 */
type PlatformRequirement =
  | Digest.Digest
  | SecureRandom.SecureRandom
  | HttpClient.HttpClient
  | SqlClient.SqlClient
  | ProviderTokenIdentity;

type ApplicationRequirement<L> = Exclude<
  L extends Layer.Layer<infer _Output, infer _Error, infer Requirement> ? Requirement : never,
  PlatformRequirement
>;

it("provides every application dependency of each service test Layer with that service's test Layer", () => {
  expectTypeOf<ApplicationRequirement<typeof achievementOutboxTestLayer>>().toEqualTypeOf<never>();
  expectTypeOf<ApplicationRequirement<typeof achievementsTestLayer>>().toEqualTypeOf<never>();
  expectTypeOf<
    ApplicationRequirement<typeof chatCommandExecutorTestLayer>
  >().toEqualTypeOf<never>();
  expectTypeOf<
    ApplicationRequirement<typeof commandsSnapshotStoreTestLayer>
  >().toEqualTypeOf<never>();
  expectTypeOf<ApplicationRequirement<typeof commandsTestLayer>>().toEqualTypeOf<never>();
  expectTypeOf<
    ApplicationRequirement<typeof computedChatCommandsTestLayer>
  >().toEqualTypeOf<never>();
  expectTypeOf<
    ApplicationRequirement<typeof eventBusAdministrationTestLayer>
  >().toEqualTypeOf<never>();
  expectTypeOf<ApplicationRequirement<typeof eventBusAlarmTestLayer>>().toEqualTypeOf<never>();
  expectTypeOf<ApplicationRequirement<typeof eventBusDatabaseTestLayer>>().toEqualTypeOf<never>();
  expectTypeOf<ApplicationRequirement<typeof eventBusTestLayer>>().toEqualTypeOf<never>();
  expectTypeOf<ApplicationRequirement<typeof eventHandlerTestLayer>>().toEqualTypeOf<never>();
  expectTypeOf<ApplicationRequirement<typeof eventPublisherTestLayer>>().toEqualTypeOf<never>();
  expectTypeOf<ApplicationRequirement<typeof eventSubDispatchTestLayer>>().toEqualTypeOf<never>();
  expectTypeOf<ApplicationRequirement<typeof eventSubInboxTestLayer>>().toEqualTypeOf<never>();
  expectTypeOf<ApplicationRequirement<typeof eventSubReceiptsTestLayer>>().toEqualTypeOf<never>();
  expectTypeOf<
    ApplicationRequirement<typeof httpRequestCorrelationTestLayer>
  >().toEqualTypeOf<never>();
  expectTypeOf<ApplicationRequirement<typeof httpResponseCacheTestLayer>>().toEqualTypeOf<never>();
  expectTypeOf<ApplicationRequirement<typeof oauthAuthorizationTestLayer>>().toEqualTypeOf<never>();
  expectTypeOf<ApplicationRequirement<typeof oauthStateClientTestLayer>>().toEqualTypeOf<never>();
  expectTypeOf<ApplicationRequirement<typeof oauthStateStoreTestLayer>>().toEqualTypeOf<never>();
  expectTypeOf<
    ApplicationRequirement<typeof providerAccessTokensTestLayer>
  >().toEqualTypeOf<never>();
  expectTypeOf<ApplicationRequirement<typeof providerTokenAlarmTestLayer>>().toEqualTypeOf<never>();
  expectTypeOf<
    ApplicationRequirement<typeof providerTokenDatabaseTestLayer>
  >().toEqualTypeOf<never>();
  expectTypeOf<
    ApplicationRequirement<typeof providerTokenExchangeTestLayer>
  >().toEqualTypeOf<never>();
  expectTypeOf<
    ApplicationRequirement<typeof providerTokenLifecycleTestLayer>
  >().toEqualTypeOf<never>();
  expectTypeOf<ApplicationRequirement<typeof raffleRandomTestLayer>>().toEqualTypeOf<never>();
  expectTypeOf<ApplicationRequirement<typeof raffleTestLayer>>().toEqualTypeOf<never>();
  expectTypeOf<ApplicationRequirement<typeof songQueueAlarmTestLayer>>().toEqualTypeOf<never>();
  expectTypeOf<
    ApplicationRequirement<typeof songQueueCoordinatorTestLayer>
  >().toEqualTypeOf<never>();
  expectTypeOf<ApplicationRequirement<typeof songQueueDatabaseTestLayer>>().toEqualTypeOf<never>();
  expectTypeOf<ApplicationRequirement<typeof songQueueTestLayer>>().toEqualTypeOf<never>();
  expectTypeOf<ApplicationRequirement<typeof spotifyServiceTestLayer>>().toEqualTypeOf<never>();
  expectTypeOf<ApplicationRequirement<typeof streamAlarmTestLayer>>().toEqualTypeOf<never>();
  expectTypeOf<ApplicationRequirement<typeof streamDatabaseTestLayer>>().toEqualTypeOf<never>();
  expectTypeOf<
    ApplicationRequirement<typeof streamLifecycleClientTestLayer>
  >().toEqualTypeOf<never>();
  expectTypeOf<ApplicationRequirement<typeof streamLifecycleTestLayer>>().toEqualTypeOf<never>();
  expectTypeOf<
    ApplicationRequirement<typeof streamViewerProviderTestLayer>
  >().toEqualTypeOf<never>();
  expectTypeOf<ApplicationRequirement<typeof twitchAnalyticsTestLayer>>().toEqualTypeOf<never>();
  expectTypeOf<
    ApplicationRequirement<typeof twitchConfigurationTestLayer>
  >().toEqualTypeOf<never>();
  expectTypeOf<ApplicationRequirement<typeof twitchServiceTestLayer>>().toEqualTypeOf<never>();
  expectTypeOf<ApplicationRequirement<typeof workflowAlarmTestLayer>>().toEqualTypeOf<never>();
  expectTypeOf<ApplicationRequirement<typeof workflowExecutionTestLayer>>().toEqualTypeOf<never>();
  expectTypeOf<ApplicationRequirement<typeof workflowJournalTestLayer>>().toEqualTypeOf<never>();
  expectTypeOf<ApplicationRequirement<typeof workflowStartersTestLayer>>().toEqualTypeOf<never>();
});
