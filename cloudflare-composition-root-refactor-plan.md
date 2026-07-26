Below is the target shape I would use. The snippets are TypeScript-oriented pseudocode: names and error unions would be aligned with existing domain types during implementation.

## Shared target layout

```text
src/
  index.ts                              # Worker composition root only
  application/
    process-eventsub-receipt.ts
    reconcile-stream-lifecycle.ts
    run-song-request.ts
  capabilities/
    song-queue.ts
  domain/
    ...
  adapters/
    http/
      create-app.ts
      create-now-playing-routes.ts
      create-oauth-routes.ts
    cloudflare/
      durable-object-rpc.ts
      durable-object-song-queue.ts
      durable-object-stream-lifecycle.ts
      cloudflare-edge-response-cache.ts
    spotify/
      spotify-oauth-client.ts
      spotify-playback-client.ts
      spotify-track-catalog.ts
    twitch/
      twitch-oauth-client.ts
      twitch-chat-sender.ts
      twitch-eventsub-administration.ts
      twitch-stream-reader.ts
  configuration/
    worker-configuration.ts
```

This is directional, not a requirement to reorganize everything before migrating behavior.

---

# 1. Make the Worker/Hono entrypoint the composition root

## Target interfaces

Each route factory gets only what its handlers use. The `SongQueueReader` capability is defined in section 2 and is injected directly because this route adds no application policy of its own.

```ts
/** Exact dependencies required by the Now Playing HTTP route. */
export type NowPlayingRouteDependencies = Readonly<{
	songQueue: SongQueueReader;
	logger: Logger;
}>;
```

The route does not know `Env`, a binding name, or how a Durable Object stub is acquired.

```ts
export function createNowPlayingRoutes(dependencies: NowPlayingRouteDependencies): Hono {
	const routes = new Hono();

	routes.get("/now-playing", async (context) => {
		const result = await dependencies.songQueue.getNowPlaying();

		if (result.status === "error") {
			dependencies.logger.error("Now Playing read failed", {
				event: "now_playing.read_failed",
				error_tag: result.error._tag,
			});

			return context.json({ error: "Unable to read Now Playing" }, 500);
		}

		return context.json(result.value);
	});

	return routes;
}
```

Do not create one global `RouteDependencies` mega-bag. Route groups should remain exact:

```ts
export type OAuthRouteDependencies = Readonly<{
	spotifyOAuth: SpotifyOAuth;
	twitchOAuth: TwitchOAuth;
	oauthAuthorizationStates: OAuthAuthorizationStateStore;
	oauthConfiguration: OAuthConfiguration;
	logger: Logger;
}>;

export type EventSubManagementRouteDependencies = Readonly<{
	eventSubAdministration: TwitchEventSubAdministration;
	authenticateAdministrator: AuthenticateAdministrator;
	eventSubConfiguration: EventSubConfiguration;
	logger: Logger;
}>;
```

## Parsed configuration

Raw Cloudflare names should be translated once:

```ts
const WorkerConfigurationSchema = z.object({
	TWITCH_CLIENT_ID: z.string().trim().min(1),
	TWITCH_CLIENT_SECRET: z.string().min(1),
	TWITCH_BROADCASTER_ID: z.string().trim().min(1),
	TWITCH_BROADCASTER_NAME: z.string().trim().min(1),
	TWITCH_EVENTSUB_SECRET: z.string().min(1),
	SPOTIFY_CLIENT_ID: z.string().trim().min(1),
	SPOTIFY_CLIENT_SECRET: z.string().min(1),
	ADMIN_SECRET: z.string().min(1),
});

export type WorkerConfiguration = Readonly<{
	twitch: TwitchProviderConfiguration;
	spotify: SpotifyProviderConfiguration;
	broadcaster: TwitchBroadcaster;
	eventSubSecret: RedactedValue<string>;
	administratorSecret: RedactedValue<string>;
}>;

/** Parses Worker bindings into application-owned configuration. */
export function parseWorkerConfiguration(
	bindings: Cloudflare.Env,
): Result<WorkerConfiguration, WorkerConfigurationError> {
	const parsed = WorkerConfigurationSchema.safeParse(bindings);

	if (!parsed.success) {
		return Result.err(
			new WorkerConfigurationError({
				parseError: parsed.error.message,
			}),
		);
	}

	return Result.ok({
		twitch: {
			clientId: parsed.data.TWITCH_CLIENT_ID,
			clientSecret: RedactedValue.fromSensitiveValue(parsed.data.TWITCH_CLIENT_SECRET),
		},
		spotify: {
			clientId: parsed.data.SPOTIFY_CLIENT_ID,
			clientSecret: RedactedValue.fromSensitiveValue(parsed.data.SPOTIFY_CLIENT_SECRET),
		},
		broadcaster: {
			id: parsed.data.TWITCH_BROADCASTER_ID,
			displayName: parsed.data.TWITCH_BROADCASTER_NAME,
		},
		eventSubSecret: RedactedValue.fromSensitiveValue(parsed.data.TWITCH_EVENTSUB_SECRET),
		administratorSecret: RedactedValue.fromSensitiveValue(parsed.data.ADMIN_SECRET),
	});
}
```

## Composition

```ts
export default {
	async fetch(
		request: Request,
		env: Cloudflare.Env,
		executionContext: ExecutionContext,
	): Promise<Response> {
		const correlation = createHttpCorrelation(request);
		const logger = createInvocationLogger(correlation);
		const tracer = createInvocationTracer(correlation);

		const configuration = parseWorkerConfiguration(env);
		if (configuration.status === "error") {
			logger.error("Worker configuration parsing failed", {
				event: "worker.configuration.invalid",
			});
			return Response.json({ error: "Service unavailable" }, { status: 503 });
		}

		const edgeResponseCache = new CloudflareEdgeResponseCache(
			caches.default,
			(task) => executionContext.waitUntil(task),
			logger,
		);

		// Cloudflare values are consumed only by adapters.
		const songQueue = new DurableObjectSongQueue(env.SONG_QUEUE_DO, tracer);

		const twitchTokens = new DurableObjectTwitchAccessTokens(env.TWITCH_TOKEN_DO, tracer);

		const twitchStreamReader = new HelixTwitchStreamReader({
			configuration: configuration.value.twitch,
			broadcaster: configuration.value.broadcaster,
			appAccessTokens: new TwitchAppAccessTokens(configuration.value.twitch),
			logger,
			tracer,
		});

		const app = createApp({
			nowPlayingRoutes: createNowPlayingRoutes({
				songQueue,
				logger,
			}),
			// Other exact route factories...
			edgeResponseCache,
			correlation,
			logger,
			tracer,
		});

		return app.fetch(request);
	},
} satisfies ExportedHandler<Cloudflare.Env>;
```

Initially, constructing the Hono graph per invocation is acceptable. Once the graph is clean, immutable route structure can be reused while invocation-scoped dependencies are composed in the earliest middleware.

## Migration

1. Export `createApp(...)` while retaining the existing default app.
2. Register `/health` directly in `createApp`; a dependency-free one-route factory would add no leverage.
3. Move one dependency-bearing route, such as `/api/now-playing`.
4. Preserve tests through `exports.default.fetch`.
5. Repeat by cohesive route group.
6. Delete module-level Hono instances once their final route moves.

---

# 2. Replace `getStub()` with application-owned ports

## Application-owned capability

Do not expose the complete `SongQueueDO` class as the contract.

```ts
/** Song Queue operations needed by HTTP and Chat Command application services. */
export interface SongQueue {
	getNowPlaying(): Promise<Result<NowPlaying, SongQueueReadError>>;

	getUpcomingTracks(limit: SongQueueLimit): Promise<Result<SpotifyQueueView, SongQueueReadError>>;

	recordPendingRequest(request: PendingRequest): Promise<Result<void, SongQueueWriteError>>;

	deletePendingRequest(
		redemptionId: ChannelPointRedemptionId,
	): Promise<Result<void, SongQueueWriteError>>;
}
```

If write and read consumers never overlap, split them:

```ts
export interface SongQueueReader {
	getNowPlaying(): Promise<Result<NowPlaying, SongQueueReadError>>;
	getUpcomingTracks(limit: SongQueueLimit): Promise<Result<SpotifyQueueView, SongQueueReadError>>;
}

export interface PendingRequestStore {
	save(request: PendingRequest): Promise<Result<void, PendingRequestStoreError>>;

	delete(redemptionId: ChannelPointRedemptionId): Promise<Result<void, PendingRequestStoreError>>;
}
```

The split should be driven by actual callers, not theoretical purity.

## Cloudflare adapter

```ts
/** Durable Object adapter for Song Queue application operations. */
export class DurableObjectSongQueue implements SongQueueReader, PendingRequestStore {
	constructor(
		private readonly namespace: DurableObjectNamespace<SongQueueDO>,
		private readonly tracer: Tracer,
	) {}

	async getNowPlaying(): Promise<Result<NowPlaying, SongQueueReadError>> {
		return this.tracer.span("durable_object.song_queue.get_now_playing", {}, async () => {
			const stubResult = this.acquireSingletonStub();
			if (stubResult.status === "error") return stubResult;

			try {
				const wireResult = await stubResult.value.getCurrentlyPlaying();

				return parseSongQueueNowPlayingRpcResult(wireResult);
			} catch (cause) {
				return Result.err(
					new SongQueueUnavailableError({
						operation: "getNowPlaying",
						cause,
					}),
				);
			}
		});
	}

	private acquireSingletonStub(): Result<
		DurableObjectStub<SongQueueDO>,
		SongQueueUnavailableError
	> {
		try {
			const id = this.namespace.idFromName("song-queue");
			return Result.ok(this.namespace.get(id));
		} catch (cause) {
			return Result.err(
				new SongQueueUnavailableError({
					operation: "acquireSingletonStub",
					cause,
				}),
			);
		}
	}
}
```

The binding name `SONG_QUEUE_DO` appears only when constructing this adapter:

```ts
const songQueue = new DurableObjectSongQueue(env.SONG_QUEUE_DO, tracer);
```

## Direct consumer use

The HTTP route should call `SongQueueReader` directly. A `GetNowPlaying` class that only forwards to `songQueue.getNowPlaying()` would be a shallow module: deleting it removes code without moving any policy or complexity elsewhere.

Introduce an application service only if the use case gains meaningful sequencing or policy. For example, stale-data fallback across two sources would earn a module:

```ts
export type ReadNowPlayingDependencies = Readonly<{
	songQueue: SongQueueReader;
	lastKnownPlayback: LastKnownPlaybackReader;
}>;

export async function readNowPlayingWithFallback(
	dependencies: ReadNowPlayingDependencies,
): Promise<Result<NowPlaying, NowPlayingReadError>> {
	const current = await dependencies.songQueue.getNowPlaying();
	if (current.status === "ok") return current;
	if (!SongQueueUnavailableError.is(current.error)) return current;

	return dependencies.lastKnownPlayback.getNowPlaying();
}
```

That function owns a caller-visible fallback decision rather than merely renaming one capability call.

## Remove the global locator

Delete this interface from inner code:

```ts
// Remove from application code:
getStub("SONG_QUEUE_DO");
getStub("STREAM_LIFECYCLE_DO");
getStub("EVENT_BUS_DO");
```

`getStubFromNamespace()` may temporarily remain private to `adapters/cloudflare`, but application modules must not import it.

---

# 3. Make every Durable Object constructor a composition root

Cloudflare still requires the Durable Object class to receive `Env`. That is permitted. The important change is that behavior does not read `this.env`.

## EventSub example

`ProcessEventSubReceipt` earns an application module because it owns dispatch and downstream effect policy. It does not need a matching `EventSubReceiptProcessor` interface unless a second production or faithful test implementation exists.

```ts
export type ProcessEventSubReceiptDependencies = Readonly<{
	streamLifecycle: StreamLifecycle;
	startSongRequest: StartSongRequest;
	startKeyboardRaffle: StartKeyboardRaffle;
	startRaidShoutout: StartRaidShoutout;
	executeChatCommand: ChatCommandExecutor;
	rewardRouting: RewardRoutingConfiguration;
	clock: Clock;
	logger: Logger;
}>;

export class ProcessEventSubReceipt {
	constructor(private readonly dependencies: ProcessEventSubReceiptDependencies) {}

	async process(receipt: AcceptedEventSubReceipt): Promise<Result<void, EventSubProcessingError>> {
		const message = parseEventSubMessage(receipt.headers, receipt.body);
		if (message.status === "error") return message;

		switch (message.value._tag) {
			case "StreamOnlineNotification":
				return this.dependencies.streamLifecycle.markOnline(message.value.event.startedAt);
			case "StreamOfflineNotification":
				return this.dependencies.streamLifecycle.markOffline(receipt.receivedAt);
			case "RewardRedemptionNotification":
				return this.processRewardRedemption(message.value.event);
			case "RaidNotification":
				return this.dependencies.startRaidShoutout.start({
					messageId: receipt.messageId,
					raider: message.value.raider,
					viewers: message.value.viewers,
				});
			case "ChatMessageNotification":
				return this.dependencies.executeChatCommand.execute(
					toChatCommandInput(receipt, message.value),
				);
			// Challenge and revocation cases...
		}
	}
}
```

Receipt storage, retry scheduling, acceptance, and alarm resumption form one cohesive durable inbox. Keep its storage and scheduling helpers private rather than exposing separate `EventSubReceiptStore`, `EventSubRetryScheduler`, `AcceptEventSubReceipt`, and `ResumeEventSubReceipt` modules.

```ts
export class DurableEventSubInbox {
	constructor(
		private readonly storage: DurableObjectStorage,
		private readonly processReceipt: (
			receipt: AcceptedEventSubReceipt,
		) => Promise<Result<void, EventSubProcessingError>>,
		private readonly clock: Clock,
		private readonly logger: Logger,
	) {}

	accept(receipt: AcceptedEventSubReceipt): Promise<Result<void, EventSubAcceptanceError>> {
		// Persist before processing, enforce receipt idempotency, process, and schedule retry.
	}

	resumePending(): Promise<void> {
		// Read pending receipt, process it, and update retry/dead-letter state.
	}
}
```

The Durable Object remains a thin protocol and composition shell:

```ts
export class EventSubWebhookDO extends DurableObject<Cloudflare.Env> {
	private readonly inbox: DurableEventSubInbox;

	constructor(context: DurableObjectState, env: Cloudflare.Env) {
		super(context, env);

		const logger = createDurableObjectLogger(context.id.toString(), "eventsub-webhook");
		const tracer = createDurableObjectTracer(logger);
		const processor = new ProcessEventSubReceipt({
			streamLifecycle: new DurableObjectStreamLifecycle(env.STREAM_LIFECYCLE_DO, tracer),
			startSongRequest: new DurableObjectSongRequestStarter(env.SONG_REQUEST_SAGA_DO, tracer),
			startKeyboardRaffle: new DurableObjectKeyboardRaffleStarter(
				env.KEYBOARD_RAFFLE_SAGA_DO,
				tracer,
			),
			startRaidShoutout: new DurableObjectRaidShoutoutStarter(env.RAID_SHOUTOUT_SAGA_DO, tracer),
			executeChatCommand: composeChatCommandExecutor({
				commandsNamespace: env.COMMANDS_DO,
				twitchTokenNamespace: env.TWITCH_TOKEN_DO,
				songQueueNamespace: env.SONG_QUEUE_DO,
				analytics: env.ANALYTICS,
				twitchConfiguration: parseTwitchConfiguration(env),
				logger,
				tracer,
			}),
			rewardRouting: parseRewardRoutingConfiguration(env),
			clock: new SystemClock(),
			logger,
		});

		this.inbox = new DurableEventSubInbox(
			context.storage,
			(receipt) => processor.process(receipt),
			new SystemClock(),
			logger,
		);
	}

	@rpc
	async accept(input: unknown): Promise<EventSubAcceptRpcResult> {
		const parsed = AcceptedEventSubReceiptSchema.safeParse(input);
		if (!parsed.success) {
			return toRpcResult(Result.err(new EventSubReceiptCorruptError(parsed.error.message)));
		}
		return toRpcResult(await this.inbox.accept(parsed.data));
	}

	async alarm(): Promise<void> {
		await this.inbox.resumePending();
	}
}
```

## Saga example

The base `SagaHost` can retain framework lifecycle mechanics, but it should not expose `Env` to concrete orchestration.

```ts
export abstract class SagaHost<P, E> extends Agent<Cloudflare.Env, SagaHostState> {
	protected constructor(
		context: AgentContext,
		env: Cloudflare.Env,
		private readonly sagaRuntime: SagaRuntime<P>,
	) {
		super(context, env);
	}

	protected abstract runSaga(parameters: P, runner: SagaRunner<P>): Promise<Result<void, E>>;
}
```

Concrete saga:

```ts
export class SongRequestSagaDO extends SagaHost<SongRequestParameters, SongRequestSagaError> {
	private readonly songRequest: RunSongRequest;

	constructor(context: AgentContext, env: Cloudflare.Env) {
		const logger = createDurableObjectLogger(context.id.toString(), "song-request-saga");

		super(context, env, createSagaRuntime(context.storage, logger));

		this.songRequest = new RunSongRequest({
			spotifyTracks: new SpotifyWebTrackCatalog(/* exact deps */),
			spotifyQueue: new SpotifyWebPlaybackQueue(/* exact deps */),
			pendingRequests: new DurableObjectPendingRequestStore(env.SONG_QUEUE_DO, logger),
			redemptions: new HelixChannelPointRedemptions(/* exact deps */),
			eventPublisher: new DurableObjectEventPublisher(env.EVENT_BUS_DO, logger),
			chatSender: new HelixTwitchChatSender(/* exact deps */),
			logger,
		});
	}

	protected runSaga(parameters: SongRequestParameters, runner: SagaRunner<SongRequestParameters>) {
		return this.songRequest.execute(parameters, runner);
	}
}
```

The remaining `Env` parameter is framework-required, but `runSaga()` and `RunSongRequest` never receive it.

---

# 4. Split provider modules by cohesive capability

`TwitchService` and `SpotifyService` should stop receiving `Env` and stop acquiring their own tokens.

## Token capability

```ts
/** Supplies a valid Spotify user access token. */
export interface SpotifyAccessTokens {
	getValidAccessToken(): Promise<Result<RedactedValue<string>, SpotifyAccessTokenError>>;
}

/** Supplies a valid Twitch broadcaster access token. */
export interface TwitchAccessTokens {
	getValidAccessToken(): Promise<Result<RedactedValue<string>, TwitchAccessTokenError>>;
}
```

Cloudflare adapter:

```ts
export class DurableObjectTwitchAccessTokens implements TwitchAccessTokens {
	constructor(
		private readonly namespace: DurableObjectNamespace<TwitchTokenDO>,
		private readonly tracer: Tracer,
	) {}

	async getValidAccessToken(): Promise<Result<RedactedValue<string>, TwitchAccessTokenError>> {
		const wireResult = await this.getStub().getValidToken();
		const parsed = parseTwitchAccessTokenRpcResult(wireResult);

		return parsed.map((token) => RedactedValue.fromSensitiveValue(token));
	}
}
```

## Narrow provider capabilities

```ts
/** Reads live Stream Session evidence from Twitch Helix. */
export interface TwitchStreamReader {
	findLiveStream(
		broadcaster: TwitchBroadcaster,
	): Promise<Result<TwitchLiveStream | null, TwitchStreamReadError>>;
}

/** Sends messages to the configured Twitch channel. */
export interface TwitchChatSender {
	sendMessage(message: TwitchChatMessage): Promise<Result<void, TwitchChatSendError>>;
}

/** Updates Channel Point Redemption status. */
export interface ChannelPointRedemptions {
	fulfill(
		redemptionId: ChannelPointRedemptionId,
	): Promise<Result<void, ChannelPointRedemptionUpdateError>>;

	cancel(
		redemptionId: ChannelPointRedemptionId,
	): Promise<Result<void, ChannelPointRedemptionUpdateError>>;
}

/** Administers Twitch EventSub webhook subscriptions. */
export interface TwitchEventSubAdministration {
	list(): Promise<Result<readonly EventSubSubscription[], EventSubAdministrationError>>;

	create(
		subscription: DesiredEventSubSubscription,
	): Promise<Result<EventSubSubscription, EventSubAdministrationError>>;

	delete(
		subscriptionId: EventSubSubscriptionId,
	): Promise<Result<void, EventSubAdministrationError>>;
}
```

## Concrete adapters

A chat sender should not receive the Twitch client secret:

```ts
export type HelixTwitchChatSenderDependencies = Readonly<{
	clientId: TwitchClientId;
	broadcaster: TwitchBroadcaster;
	accessTokens: TwitchAccessTokens;
	logger: Logger;
	tracer: Tracer;
}>;

export class HelixTwitchChatSender implements TwitchChatSender {
	constructor(private readonly dependencies: HelixTwitchChatSenderDependencies) {}

	async sendMessage(message: TwitchChatMessage): Promise<Result<void, TwitchChatSendError>> {
		const token = await this.dependencies.accessTokens.getValidAccessToken();

		if (token.status === "error") {
			return Result.err(translateTwitchAccessTokenError(token.error));
		}

		// Own HTTP serialization, response parsing and short technical retry.
		return sendHelixChatMessage({
			clientId: this.dependencies.clientId,
			token: token.value,
			broadcaster: this.dependencies.broadcaster,
			message,
		});
	}
}
```

EventSub administration does need app credentials:

```ts
export type HelixEventSubAdministrationDependencies = Readonly<{
	broadcaster: TwitchBroadcaster;
	appAccessTokens: TwitchAppAccessTokens;
	logger: Logger;
	tracer: Tracer;
}>;
```

Spotify follows the same pattern:

```ts
export interface SpotifyTrackCatalog {
	findTrack(id: SpotifyTrackId): Promise<Result<SpotifyTrack, SpotifyTrackLookupError>>;
}

export interface SpotifyPlaybackQueue {
	enqueue(track: SpotifyTrackUri): Promise<Result<void, SpotifyQueueMutationError>>;

	readQueue(): Promise<Result<SpotifyQueueSnapshot, SpotifyQueueReadError>>;

	skipCurrentTrack(): Promise<Result<void, SpotifyPlaybackMutationError>>;
}
```

## Migration

1. Change existing constructors from `Pick<Env, ...>` to parsed configuration.
2. Inject token capabilities.
3. Have the existing classes implement narrow interfaces temporarily.
4. Move cohesive methods into named adapters incrementally.
5. Remove `getStub()` from provider modules.
6. Remove provider re-exports from `index.ts`.

Do not automatically create one concrete class or file per narrow capability interface. One cohesive Helix or Spotify implementation may satisfy several consumer-owned interfaces while sharing authentication, HTTP parsing, and retry mechanics internally. Split the implementation only when those mechanics or reasons to change diverge. Likewise, keep `fetch` private to the provider adapter while the existing Cloudflare fetch-mock integration tests are sufficient; inject an HTTP transport only when a real alternate implementation or test seam is needed.

---

# 5. Make every Durable Object RPC result runtime-validated

## Do not infer application contracts from DO classes

Replace:

```ts
type DeserializedStub<DO> = /* inferred from concrete DO */;
```

with explicit wire and application contracts.

## Wire schemas

```ts
const NowPlayingSchema = z.object({
	track: SpotifyTrackSchema.nullable(),
	position: z.number().int().nonnegative(),
});

const SongQueueReadErrorSchema = z.discriminatedUnion("_tag", [
	z.object({
		_tag: z.literal("SongQueueDbError"),
		message: z.string(),
		operation: z.string(),
	}),
	z.object({
		_tag: z.literal("SongQueueParseError"),
		message: z.string(),
		operation: z.string(),
	}),
]);

const GetNowPlayingRpcResultSchema = z.discriminatedUnion("status", [
	z.object({
		status: z.literal("ok"),
		value: NowPlayingSchema,
	}),
	z.object({
		status: z.literal("error"),
		error: SongQueueReadErrorSchema,
	}),
]);
```

## Method-specific parser

Keep a parser private to its adapter when no other production module consumes the wire representation. Test the wire contract through the adapter's public capability interface.

```ts
/** Parses the complete Song Queue get-currently-playing RPC contract. */
function parseSongQueueNowPlayingRpcResult(
	input: unknown,
): Result<NowPlaying, SongQueueReadError | DurableObjectRpcProtocolError> {
	const parsed = GetNowPlayingRpcResultSchema.safeParse(input);

	if (!parsed.success) {
		return Result.err(
			new DurableObjectRpcProtocolError({
				method: "SongQueueDO.getCurrentlyPlaying",
				payloadPart: "result",
				parseError: parsed.error.message,
			}),
		);
	}

	if (parsed.data.status === "error") {
		return Result.err(deserializeSongQueueReadError(parsed.data.error));
	}

	return Result.ok(parsed.data.value);
}
```

## Adapter owns transport translation

This is the same `DurableObjectSongQueue` introduced in section 2, deepened with runtime parsing—not a second wrapper layered around it.

```ts
export class DurableObjectSongQueue implements SongQueueReader {
	async getNowPlaying(): Promise<
		Result<NowPlaying, SongQueueReadError | SongQueueUnavailableError>
	> {
		try {
			const rawResult = await this.getStub().getCurrentlyPlaying();

			return parseSongQueueNowPlayingRpcResult(rawResult).mapError(translateSongQueueRpcError);
		} catch (cause) {
			return Result.err(
				new SongQueueUnavailableError({
					operation: "getNowPlaying",
					cause,
				}),
			);
		}
	}
}
```

## Reduce the global error registry

Instead of one `KnownRpcErrorSchema` containing every error in the application, colocate schemas by capability:

```text
adapters/cloudflare/
  song-queue-rpc.ts
  stream-lifecycle-rpc.ts
  event-publisher-rpc.ts
  token-lifecycle-rpc.ts
```

Each file owns:

- singleton naming;
- wire schemas;
- serialization/deserialization;
- Cloudflare exception translation;
- application capability implementation.

A shared envelope helper is still useful:

```ts
export function rpcResultSchema<T, E>(success: z.ZodType<T>, error: z.ZodType<E>) {
	return z.discriminatedUnion("status", [
		z.object({ status: z.literal("ok"), value: success }),
		z.object({ status: z.literal("error"), error }),
	]);
}
```

It must never provide an unchecked-cast fallback.

---

# 6. Remove Hono and `ExecutionContext` from cache policy

Edge caching is protocol/runtime behavior, so it can remain in one deep Cloudflare adapter. Separate `BackgroundTasks`, `EdgeJsonCache`, `CloudflareEdgeJsonCache`, and `readThroughJsonCache` modules would make the caller assemble cache mechanics without gaining useful variation.

## Deep cache adapter

```ts
export type ReadThroughEdgeResponseOptions<T, E> = Readonly<{
	key: EdgeCacheKey;
	maxAgeSeconds: number;
	schema: z.ZodType<T>;
	load: () => Promise<Result<T, E>>;
}>;

/** Owns validated read-through edge caching and best-effort detached writes. */
export class CloudflareEdgeResponseCache {
	constructor(
		private readonly cache: Cache,
		private readonly schedule: (task: Promise<void>) => void,
		private readonly logger: Logger,
	) {}

	async readThrough<T, E>(
		options: ReadThroughEdgeResponseOptions<T, E>,
	): Promise<Result<T, E | EdgeCacheValueError>> {
		const cached = await this.findValidated(options.key, options.schema);
		if (cached.status === "ok" && cached.value !== null) return cached;

		if (cached.status === "error" && EdgeCacheCorruptEntryError.is(cached.error)) {
			this.schedule(this.deleteBestEffort(options.key));
		}

		// Cache outages are best effort: continue to the source.
		const fresh = await options.load();
		if (fresh.status === "error") return fresh;

		this.schedule(this.storeBestEffort(options.key, fresh.value, options.maxAgeSeconds));
		return fresh;
	}

	private findValidated<T>(key: EdgeCacheKey, schema: z.ZodType<T>) {
		// Cache lookup, JSON parsing, schema validation, and precise error classification.
	}

	private deleteBestEffort(key: EdgeCacheKey): Promise<void> {
		// Delete and log without exposing cache failure to the route.
	}

	private storeBestEffort<T>(key: EdgeCacheKey, value: T, maxAgeSeconds: number): Promise<void> {
		// Serialize, store, and log without exposing cache failure to the route.
	}
}
```

The composition root translates `ExecutionContext` once without introducing a one-method class:

```ts
const edgeResponseCache = new CloudflareEdgeResponseCache(
	caches.default,
	(task) => executionContext.waitUntil(task),
	logger,
);
```

## Route projection

```ts
routes.get("/top-tracks", async (context) => {
	const query = parseTopTracksQuery(context.req.query());
	if (query.status === "error") {
		return context.json({ error: query.error.message }, 400);
	}

	const result = await dependencies.edgeResponseCache.readThrough({
		key: topTracksCacheKey(query.value),
		maxAgeSeconds: 60,
		schema: TopTracksSchema,
		load: () => dependencies.stats.getTopTracks(query.value.limit),
	});

	return projectTopTracksResult(context, result);
});
```

No Hono `Context`, `caches.default`, or `ExecutionContext` enters route-independent policy. Add a general `BackgroundTasks` capability only when a second inner consumer needs detached-work ownership.

---

# 7. Propagate tracing and correlation across runtime surfaces

## Invocation context

```ts
export type TraceId = string & z.BRAND<"TraceId">;
export type RequestId = string & z.BRAND<"RequestId">;

export type InvocationCorrelation = Readonly<{
	traceId: TraceId;
	requestId?: RequestId;
	messageId?: EventSubMessageId;
}>;
```

## Tracer interface

```ts
export interface Tracer {
	span<T>(
		name: string,
		attributes: Readonly<Record<string, TraceAttribute>>,
		run: () => Promise<T>,
	): Promise<T>;
}
```

Services and adapters receive the tracer once:

```ts
export type ReconcileStreamLifecycleDependencies = Readonly<{
	streamLifecycle: StreamLifecycle;
	twitchStreams: TwitchStreamReader;
	tracer: Tracer;
}>;

export class ReconcileStreamLifecycle {
	constructor(private readonly dependencies: ReconcileStreamLifecycleDependencies) {}

	execute(): Promise<Result<Reconciliation, ReconciliationError>> {
		return this.dependencies.tracer.span("stream_lifecycle.reconcile", {}, async () => {
			// Effect sequencing...
		});
	}
}
```

Do not add `tracer` to every method signature.

## Correlation across durable work

Do not wrap every Durable Object RPC in a generic `RpcCall<T>` envelope solely to carry correlation. That would enlarge every interface and duplicate transport mechanics even for synchronous calls whose existing operation IDs already provide useful linkage.

Persist correlation only when work can detach from the originating invocation, such as an EventSub receipt resumed by an alarm:

```ts
type PersistedEventSubReceipt = Readonly<{
	// Existing fields...
	correlation: InvocationCorrelation;
}>;
```

The accepting adapter adds correlation as receipt metadata, not as a domain argument:

```ts
await eventSubInbox.accept({
	...receipt,
	correlation,
});
```

When an alarm resumes the receipt, create a logger/tracer from the persisted correlation before invoking processing. For synchronous RPC calls, retain domain operation IDs such as EventSub message IDs and Channel Point Redemption IDs and rely on adapter spans rather than introducing a universal envelope. Add explicit RPC correlation later only where production traces demonstrate a concrete gap.

## Telemetry safety

Attributes should use IDs and bounded enums, not:

- OAuth codes;
- access tokens;
- EventSub signatures;
- raw webhook bodies;
- arbitrary Viewer chat text.

---

# 8. Add architecture enforcement

Use two layers: import restrictions for reliable ownership rules and a small source audit for patterns import rules cannot detect.

## Allowed zones

```ts
const CLOUDFLARE_RUNTIME_ALLOWED_PATHS = [
	"src/index.ts",
	"src/adapters/cloudflare/",
	"src/durable-objects/",
	"src/__tests__/",
] as const;

const HONO_ALLOWED_PATHS = [
	"src/index.ts",
	"src/adapters/http/",
	"src/routes/", // Temporary migration allowance.
	"src/__tests__/",
] as const;
```

## Architecture test pseudocode

```ts
describe("Cloudflare composition architecture", () => {
	const productionFiles = findProductionTypeScriptFiles("apps/api/src");

	it("confines Cloudflare runtime imports", async () => {
		const violations = await findImports({
			files: productionFiles,
			moduleNames: ["cloudflare:workers"],
			exceptPaths: CLOUDFLARE_RUNTIME_ALLOWED_PATHS,
		});

		expect(violations).toEqual([]);
	});

	it("confines generated Env references", async () => {
		const violations = await findSourceMatches({
			files: productionFiles,
			pattern: /\b(?:Cloudflare\.)?Env\b/u,
			exceptPaths: CLOUDFLARE_RUNTIME_ALLOWED_PATHS,
		});

		expect(violations).toEqual([]);
	});

	it("prevents route binding lookup", async () => {
		const violations = await findSourceMatches({
			files: productionFiles,
			includePaths: ["src/adapters/http/", "src/routes/"],
			pattern: /\bc\.env\b/u,
		});

		expect(violations).toEqual([]);
	});

	it("prevents application binding names", async () => {
		const violations = await findSourceMatches({
			files: productionFiles,
			includePaths: ["src/application/", "src/domain/", "src/lib/chat-command/"],
			pattern: /\b[A-Z][A-Z0-9_]*(?:_DO|_BUCKET|_KV|_QUEUE)\b/u,
		});

		expect(violations).toEqual([]);
	});

	it("prevents the global Durable Object locator", async () => {
		const violations = await findImports({
			files: productionFiles,
			importedNames: ["getStub"],
			exceptPaths: ["src/adapters/cloudflare/"],
		});

		expect(violations).toEqual([]);
	});
});
```

An AST-based implementation with `ts-morph` is preferable to regex for imports and type references. Regex is reasonable for `c.env` and binding-name leakage.

## Lint integration

```json
{
	"scripts": {
		"architecture": "tsx tools/architecture/check-cloudflare-composition.ts",
		"check": "vp check && pnpm architecture && vp run --filter \"./apps/*\" typecheck"
	}
}
```

## Ratchet migration

Do not wait for the entire refactor:

```ts
const TEMPORARY_ENV_ALLOWLIST = [
	"src/routes/api.ts",
	"src/routes/oauth.ts",
	"src/routes/webhooks.ts",
] as const;
```

Every migrated file is removed from the allowlist in the same change. New violations fail immediately.

## Testing after refactoring

Retain the current Cloudflare integration tests and add tests through the new real interfaces:

```ts
class RecordingTwitchChatSender
  implements TwitchChatSender
{
  readonly messages: TwitchChatMessage[] = [];

  async sendMessage(
    message: TwitchChatMessage,
  ): Promise<Result<void, never>> {
    this.messages.push(message);
    return Result.ok(undefined);
  }
}

it("sends the rendered Chat Command response", async () => {
  const sender = new RecordingTwitchChatSender();

  const commands = new ChatCommandEngine({
    catalog: new InMemoryCommandCatalog([...]),
    sender,
    metrics: new RecordingChatCommandMetrics(),
    clock: new TestClock(...),
    logger: new RecordingLogger(),
  });

  const result = await commands.execute(input);

  expect(result.status).toBe("ok");
  expect(sender.messages).toEqual([
    TwitchChatMessage.make("Now playing: ..."),
  ]);
});
```

Adapter serialization remains tested against the Cloudflare local runtime rather than mocked modules.

---

# 9. Refresh and maintain the code-path audit

The document should identify exactly what source state it describes.

## Header format

```md
# Application code-path audit

- Audited commit: `abc1234`
- Audited on: `2026-08-03`
- Runtime entrypoint: `apps/api/src/index.ts`
- Wrangler configuration: `apps/api/wrangler.jsonc`

## Verification

- `pnpm --filter cf-twitch-api typecheck`: passed
- `pnpm --filter cf-twitch-api test -- --run`: passed
- Test file and assertion counts are intentionally omitted because they
  become stale without changing application behavior.
```

Omitting volatile counts is better than repeatedly publishing stale counts.

## Findings should have status

```md
## Finding: EventSub management authentication

Status: Resolved
Resolved by: `abc1234`
Evidence:

- `apps/api/src/routes/eventsub-setup.ts`
- Bearer authentication applies to every management route.
- Missing credentials return 401.
- Invalid credentials return 403.

Regression evidence:

- `apps/api/src/__tests__/routes/eventsub-setup.test.ts`
```

Current unresolved findings should link to GitHub Issues:

```md
## Finding: Global Durable Object service locator

Status: Open
Tracking issue: #123
Priority: High

`getStub()` reads ambient Worker bindings and exposes Cloudflare
binding names to application modules.

Target seam:

- Application-owned capabilities such as `SongQueueReader`
- Namespace-backed adapters such as `DurableObjectSongQueue`
```

## Separate topology from findings

```text
docs/
  runtime-topology.md        # Stable description of serving surfaces
  code-path-audit.md         # Point-in-time findings and evidence
```

The stable document should explain:

- Worker routes;
- Durable Object entrypoints;
- EventSub processing;
- saga lifecycle;
- external provider interactions.

The point-in-time audit should contain:

- commit;
- scope;
- verification;
- open findings;
- resolved findings;
- known limitations.

Do not add a test that only checks whether the recorded commit looks like a Git hash. It would verify document formatting rather than freshness or application behavior. Make age visible in the document and update it when a tracked behavior or finding changes.

---

# Suggested implementation slices

To avoid a repository-wide rewrite:

1. **Now Playing vertical slice**
   - `SongQueueReader`
   - `DurableObjectSongQueue`
   - direct route-to-capability invocation in `createNowPlayingRoutes`
   - Worker composition

2. **Token acquisition and Twitch stream reading**
   - `TwitchAccessTokens`
   - `DurableObjectTwitchAccessTokens`
   - `TwitchStreamReader`
   - migrate reconciliation

3. **EventSub durable processing**
   - compose `EventSubWebhookDO`
   - remove `getStub()` from its implementation
   - propagate correlation

4. **Song Request saga**
   - extract `RunSongRequest`
   - inject Spotify, Twitch, Song Queue, Event Publisher capabilities

5. **Remaining routes and Durable Objects**
   - migrate by cohesive behavior

6. **Delete ambient infrastructure**
   - remove global `getStub()`
   - remove global Cloudflare `env` imports
   - remove `Env` imports from routes and provider modules
   - enforce the final architecture rules.
