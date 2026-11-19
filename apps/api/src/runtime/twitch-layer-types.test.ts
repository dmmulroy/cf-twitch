import { expectTypeOf, it } from "@effect/vitest";
import type * as Cloudflare from "@alchemy.run/cloudflare";
import type { Layer, Scope } from "effect";
import type { Digest, SecureRandom } from "effect/crypto";
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
