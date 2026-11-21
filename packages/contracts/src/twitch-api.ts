import { Schema } from "effect";
import {
  QueuedTrack,
  SongQueueResult,
  RequestHistoryResult,
  TopRequestedTrack,
  TopSongRequester,
} from "./song-queue.ts";
import {
  AchievementDefinition,
  AchievementLeaderboardEntry,
  ViewerAchievementProgress,
  UnlockedAchievement,
} from "./achievement.ts";
import { RaffleLeaderboardEntry } from "./raffle.ts";
import { DeadLetterEventList, PendingEventList } from "./event-bus.ts";
import { AchievementDebugTableCounts, AchievementDebugUserSnapshot } from "./achievement.ts";
import {
  ChatCommandDefinition,
  ChatCommandDebugSnapshot,
  CreateChatCommandInput,
  UpdateChatCommandInput,
} from "./chat-command.ts";
import { StreamLifecycleState } from "./stream.ts";
import { OAuthProvider, ProviderEventSubSubscription, ProviderFailureReason } from "./provider.ts";
import { ViewerId } from "./identity.ts";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/http-api";

/** Schema for an EventSub subscription in management responses; an absent callback key is omitted, as Twitch management clients expect. */
export const TwitchSubscriptionResponse = Schema.Struct({
  ...ProviderEventSubSubscription.fields,
  transport: Schema.Struct({
    method: Schema.String,
    callback: Schema.OptionFromOptionalKey(Schema.String),
  }),
});

/** Endpoint name reported in a public error's `operation`; `routeRequest` and `handleRequest` cover unmatched routes and unexpected failures. */
export const TwitchHttpOperation = Schema.Literals([
  "health",
  "nowPlaying",
  "queue",
  "requestHistory",
  "achievementDefinitions",
  "achievementLeaderboard",
  "viewerAchievements",
  "viewerUnlockedAchievements",
  "topTracks",
  "viewerTopTracks",
  "topRequesters",
  "raffleLeaderboard",
  "raffleViewer",
  "deadLetters",
  "pendingEvents",
  "replayDeadLetter",
  "deleteDeadLetter",
  "resetAchievements",
  "achievementCounts",
  "achievementSnapshot",
  "commands",
  "createCommand",
  "updateCommand",
  "deleteCommand",
  "commandsSnapshot",
  "viewerStatsDebug",
  "streamState",
  "raffleLeaderboardDebug",
  "reconcileStream",
  "debugStatus",
  "spotifyAuthorize",
  "spotifyCallback",
  "twitchAuthorize",
  "twitchCallback",
  "webhook",
  "setupSubscriptions",
  "listSubscriptions",
  "deleteSubscription",
  "cleanupSubscriptions",
  "nowPlayingOverlay",
  "routeRequest",
  "handleRequest",
]);

/** Endpoint name reported in a public error's `operation`. */
export type TwitchHttpOperation = typeof TwitchHttpOperation.Type;

/** HTTP statuses a public error response may use, each chosen for what the failure means to the caller. */
export const TwitchHttpErrorStatus = Schema.Literals([400, 401, 404, 409, 500, 503]);

/** HTTP status of a public error response. */
export type TwitchHttpErrorStatus = typeof TwitchHttpErrorStatus.Type;

/** Credential audience named in authentication failures, so callers know which secret was expected. */
export const TwitchHttpAuthenticationAudience = Schema.Literals([
  "Admin API",
  "Debug API",
  "EventSub management",
  "EventSub webhook",
  "OAuth setup",
]);

/** Credential audience named in authentication failures. */
export type TwitchHttpAuthenticationAudience = typeof TwitchHttpAuthenticationAudience.Type;

/** Capability named in a public service failure, without exposing storage or transport internals. */
export const TwitchHttpService = Schema.Literals([
  "songQueue",
  "keyboardRaffle",
  "achievements",
  "eventBus",
  "chatCommands",
  "streamLifecycle",
  "oauthState",
  "eventSubReceipts",
  "twitch",
  "spotify",
]);

/** Capability named in a public service failure. */
export type TwitchHttpService = typeof TwitchHttpService.Type;

const issuePath = Schema.Array(Schema.Union([Schema.String, Schema.Number]));

const issueBase = { path: issuePath, message: Schema.String };

const issueLiteralValue = Schema.Union([Schema.String, Schema.Number, Schema.Boolean]);

/** Schema for one field-level validation issue in historical Zod-compatible form; it never echoes rejected input values. */
export const TwitchHttpValidationIssue = Schema.Union([
  Schema.Struct({
    ...issueBase,
    code: Schema.Literal("invalid_type"),
    expected: Schema.String,
    format: Schema.optionalKey(Schema.Literal("safeint")),
    received: Schema.optionalKey(Schema.Literals(["NaN", "Infinity"])),
  }),
  Schema.Struct({
    ...issueBase,
    code: Schema.Literal("too_small"),
    origin: Schema.Literals(["number", "int", "string", "array"]),
    minimum: Schema.Number,
    inclusive: Schema.Literal(true),
    note: Schema.optionalKey(Schema.String),
  }),
  Schema.Struct({
    ...issueBase,
    code: Schema.Literal("too_big"),
    origin: Schema.Literals(["number", "int", "string", "array"]),
    maximum: Schema.Number,
    inclusive: Schema.Literal(true),
    note: Schema.optionalKey(Schema.String),
  }),
  Schema.Struct({
    ...issueBase,
    code: Schema.Literal("invalid_value"),
    values: Schema.Array(issueLiteralValue),
  }),
  Schema.Struct({
    ...issueBase,
    code: Schema.Literal("unrecognized_keys"),
    keys: Schema.Array(Schema.String),
  }),
  Schema.Struct({ ...issueBase, code: Schema.Literal("custom") }),
  Schema.Struct({
    ...issueBase,
    code: Schema.Literal("invalid_format"),
    origin: Schema.Literal("string"),
    format: Schema.Literals(["regex", "datetime"]),
    pattern: Schema.String,
  }),
  Schema.Struct({
    ...issueBase,
    code: Schema.Literal("invalid_union"),
    errors: Schema.Array(Schema.Never),
    note: Schema.Literal("No matching discriminator"),
    discriminator: Schema.Literal("responseType"),
  }),
]);

/** One field-level validation issue in a public error's `details`. */
export type TwitchHttpValidationIssue = typeof TwitchHttpValidationIssue.Type;

const audienceDetails = Schema.Struct({ audience: TwitchHttpAuthenticationAudience });

const serviceDetails = Schema.Struct({ service: TwitchHttpService });

const providerDetails = Schema.Struct({ provider: OAuthProvider });

const providerFailureDetails = Schema.Struct({
  provider: OAuthProvider,
  failure: ProviderFailureReason,
});

const validationDetails = Schema.Array(TwitchHttpValidationIssue);

const noDetails = Schema.Struct({});

const subscriptionSetupError = Schema.Struct({
  type: Schema.String,
  error: Schema.String,
  code: Schema.Literals(["TwitchParseError", "TwitchSubscriptionCreateError"]),
});

const subscriptionConfig = Schema.Struct({
  type: Schema.String,
  version: Schema.String,
  condition: Schema.Record(Schema.String, Schema.String),
});

/**
 * Builds one public error variant whose literal `code` is paired with its own `details` schema.
 *
 * **Details**
 *
 * `error` keeps the historical short summary for existing clients; `message` is the complete
 * operation-specific explanation ending with one way forward.
 */
const twitchHttpErrorVariant = <const Code extends string, Details extends Schema.Top>(
  code: Code,
  details: Details,
) =>
  Schema.Struct({
    /** Stable literal error code; callers branch on it, and it selects the `details` schema. */
    code: Schema.Literal(code),
    /** Same text as `message`, kept for clients that read the historical `error` field. */
    error: Schema.String,
    /** Endpoint that failed, such as `createCommand`. */
    operation: TwitchHttpOperation,
    /** Explanation naming the failure and its reason, ending with one way forward. */
    message: Schema.String,
    /** Safe context specific to this code, such as the rejected fields or the requested identifier. */
    details,
    /** Server-generated request ID, also returned in the `x-request-id` header, for correlating logs. */
    requestId: Schema.String,
    /** Whether repeating the same request is safe and may succeed. */
    retryable: Schema.Boolean,
  });

/**
 * Schema for every public error response body, discriminated by its literal `code`.
 *
 * **Details**
 *
 * Each variant carries a stable `code`, the endpoint `operation`, an explanatory `message`, its own
 * `details`, the server-owned `requestId` also returned in `x-request-id`, and a truthful
 * `retryable`. The legacy `error` summary remains for existing clients. Bodies never contain
 * credentials, signed bodies, provider responses, SQL, or stack traces.
 */
export const TwitchHttpErrorBody = Schema.Union([
  twitchHttpErrorVariant("AuthenticationNotConfigured", audienceDetails),
  twitchHttpErrorVariant("AuthenticationUnavailable", audienceDetails),
  twitchHttpErrorVariant("AuthorizationMissing", audienceDetails),
  twitchHttpErrorVariant("AuthorizationMalformed", audienceDetails),
  twitchHttpErrorVariant("CredentialRejected", audienceDetails),
  twitchHttpErrorVariant("InvalidQueryParameters", validationDetails),
  twitchHttpErrorVariant("InvalidJsonBody", noDetails),
  twitchHttpErrorVariant("InvalidCommandPayload", validationDetails),
  twitchHttpErrorVariant("InvalidCommandNameError", Schema.Struct({ commandName: Schema.String })),
  twitchHttpErrorVariant("InvalidEventId", Schema.Struct({ eventId: Schema.String })),
  twitchHttpErrorVariant("InvalidViewerId", Schema.Struct({ user: Schema.String })),
  twitchHttpErrorVariant("InvalidViewerDisplayName", Schema.Struct({ parameter: Schema.String })),
  twitchHttpErrorVariant("ViewerNotFound", Schema.Struct({ userId: Schema.String })),
  twitchHttpErrorVariant("ViewerAchievementsNotFound", Schema.Struct({ user: Schema.String })),
  twitchHttpErrorVariant("DeadLetterNotFound", Schema.Struct({ eventId: Schema.String })),
  twitchHttpErrorVariant("CommandNotFoundError", Schema.Struct({ commandName: Schema.String })),
  twitchHttpErrorVariant(
    "CommandAlreadyExistsError",
    Schema.Struct({ commandName: Schema.String }),
  ),
  twitchHttpErrorVariant(
    "CommandAliasConflictError",
    Schema.Struct({ alias: Schema.String, owner: Schema.String }),
  ),
  twitchHttpErrorVariant("CommandInputParseError", noDetails),
  twitchHttpErrorVariant(
    "CommandInvalidDefinitionError",
    Schema.Struct({ commandName: Schema.String, rule: Schema.String }),
  ),
  twitchHttpErrorVariant(
    "CommandNotUpdateableError",
    Schema.Struct({ commandName: Schema.String }),
  ),
  twitchHttpErrorVariant(
    "CommandUpdatePermissionDeniedError",
    Schema.Struct({ commandName: Schema.String }),
  ),
  twitchHttpErrorVariant("StreamEffectsPending", noDetails),
  twitchHttpErrorVariant(
    "StreamReconciliationUnconfirmed",
    Schema.Struct({
      action: Schema.Literals(["noop", "set_online", "set_offline"]),
      before: StreamLifecycleState,
    }),
  ),
  twitchHttpErrorVariant("ServiceUnavailable", serviceDetails),
  twitchHttpErrorVariant("OutcomeUnknown", serviceDetails),
  twitchHttpErrorVariant("InvalidServiceResponse", serviceDetails),
  twitchHttpErrorVariant("StoredDataInvalid", serviceDetails),
  twitchHttpErrorVariant("ServiceFailed", serviceDetails),
  twitchHttpErrorVariant(
    "RouteNotFound",
    Schema.Struct({ method: Schema.String, path: Schema.String }),
  ),
  twitchHttpErrorVariant("InternalFailure", noDetails),
  twitchHttpErrorVariant("invalid", providerDetails),
  twitchHttpErrorVariant("expired", providerDetails),
  twitchHttpErrorVariant("consumed", providerDetails),
  twitchHttpErrorVariant("mismatch", providerDetails),
  twitchHttpErrorVariant("provider_denied", providerDetails),
  twitchHttpErrorVariant("AuthorizationCodeMissing", providerDetails),
  twitchHttpErrorVariant("InvalidCallbackUrl", providerDetails),
  twitchHttpErrorVariant("SpotifyParseError", providerDetails),
  twitchHttpErrorVariant("TwitchParseError", providerDetails),
  twitchHttpErrorVariant("SpotifyTokenExchangeError", providerFailureDetails),
  twitchHttpErrorVariant("TwitchTokenExchangeError", providerFailureDetails),
  twitchHttpErrorVariant("ProviderAccessTokenError", providerDetails),
  twitchHttpErrorVariant("TwitchNetworkError", providerFailureDetails),
  twitchHttpErrorVariant("TwitchSubscriptionRequestError", providerFailureDetails),
  twitchHttpErrorVariant("TwitchSubscriptionDeleteError", providerFailureDetails),
  twitchHttpErrorVariant(
    "TwitchSubscriptionNotFound",
    Schema.Struct({ subscriptionId: Schema.String }),
  ),
  twitchHttpErrorVariant(
    "SubscriptionSetupIncomplete",
    Schema.Struct({
      created: Schema.Array(TwitchSubscriptionResponse),
      skipped: Schema.Array(subscriptionConfig),
      errors: Schema.Array(subscriptionSetupError),
    }),
  ),
  twitchHttpErrorVariant("InvalidEventSubHeaders", noDetails),
  twitchHttpErrorVariant(
    "EventSubTimestampOutOfWindow",
    Schema.Struct({ toleranceSeconds: Schema.Literal(600) }),
  ),
  twitchHttpErrorVariant(
    "EventSubBodyTooLarge",
    Schema.Struct({ maximumBytes: Schema.Literal(1_048_576) }),
  ),
  twitchHttpErrorVariant("InvalidEventSubBody", noDetails),
  twitchHttpErrorVariant("EventSubSignatureInvalid", noDetails),
  twitchHttpErrorVariant("InvalidEventSubJson", noDetails),
  twitchHttpErrorVariant("InvalidEventSubPayload", noDetails),
  twitchHttpErrorVariant("EventSubReceiptConflict", Schema.Struct({ messageId: Schema.String })),
  twitchHttpErrorVariant("EventSubAcceptanceFailed", Schema.Struct({ messageId: Schema.String })),
]);

/** Public error response body, discriminated by `code`. */
export type TwitchHttpErrorBody = typeof TwitchHttpErrorBody.Type;

/** Stable public error code, one per error body variant. */
export type TwitchHttpErrorCode = TwitchHttpErrorBody["code"];

const errors = TwitchHttpErrorStatus.literals.map((status) =>
  TwitchHttpErrorBody.pipe(HttpApiSchema.status(status)),
);

const limitParameter = {
  name: "limit",
  in: "query",
  required: false,
  schema: { type: "integer", minimum: 1, maximum: 100, default: 10 },
} satisfies OpenApi.OpenAPISpecParameter;

const userPathParameter = {
  name: "user",
  in: "path",
  required: true,
  schema: { type: "string" },
} satisfies OpenApi.OpenAPISpecParameter;

const limitQuery = OpenApi.annotations({
  description: "Rejects unknown query keys and repeated scalar values. The default limit is 10.",
  override: { parameters: [limitParameter] },
});

const leaderboardQuery = OpenApi.annotations({
  description: "Rejects unknown query keys and repeated scalar values.",
  override: {
    parameters: [
      limitParameter,
      {
        name: "sortBy",
        in: "query",
        required: false,
        schema: { type: "string", enum: ["rolls", "wins", "closest"], default: "closest" },
      },
    ],
  },
});

const pageQuery = OpenApi.annotations({
  description:
    "Administrator pagination ignores unknown query keys and selects the first repeated value.",
  override: {
    parameters: [
      { ...limitParameter, schema: { ...limitParameter.schema, default: 50 } },
      {
        name: "offset",
        in: "query",
        required: false,
        schema: { type: "integer", minimum: 0, default: 0 },
      },
    ],
  },
});

const viewerTopTracksQuery = OpenApi.annotations({
  override: { parameters: [userPathParameter, limitParameter] },
});

const callbackQuery = OpenApi.annotations({
  description:
    "Consumes a durable one-use state bound to the provider and exact redirect URI before checking provider denial or code. No setup secret or cookie is required on callbacks.",
  override: {
    parameters: ["state", "code", "error", "error_description"].map((name) => ({
      name,
      in: "query",
      required: name === "state",
      schema: { type: "string" },
    })),
  },
});

const webhookHeaders = OpenApi.annotations({
  description:
    "Raw body is bounded to 1 MiB and decoded with fatal UTF-8. Require timestamp within ±10 minutes and HMAC-SHA256(messageId + timestamp + exact body bytes) before JSON parsing. Header/body subscription type and version must agree. A reused message ID with different content returns 409.",
  override: {
    parameters: [
      "twitch-eventsub-message-id",
      "twitch-eventsub-message-retry",
      "twitch-eventsub-message-type",
      "twitch-eventsub-message-signature",
      "twitch-eventsub-message-timestamp",
      "twitch-eventsub-subscription-type",
      "twitch-eventsub-subscription-version",
    ].map((name) => ({ name, in: "header", required: true, schema: { type: "string" } })),
  },
});

const administratorSecurityRequirements = [{ AdministratorBearer: [] }];

const administratorSecurity = OpenApi.annotations({
  override: { security: administratorSecurityRequirements },
});

const administratorSecurityTransform = OpenApi.annotations({
  transform: (operation) => ({ ...operation, security: administratorSecurityRequirements }),
});

const setupSecurity = OpenApi.annotations({ override: { security: [{ OAuthSetupHeader: [] }] } });

const json = { success: Schema.Json, error: errors };

/** Schema for the Now Playing response; an absent track encodes as `null`. */
export const TwitchNowPlayingResponse = Schema.Struct({
  track: Schema.OptionFromNullOr(QueuedTrack),
  position: Schema.Literal(0),
});

/** Schema for a statistics route Viewer ID, restricted to the historical 1–20 digit Twitch user ID. */
export const TwitchStatsViewerId = ViewerId.check(Schema.isPattern(/^\d{1,20}$/u));

/** Schema for the top requesters response; encoding rejects non-numeric Viewer IDs before a value is cached. */
export const TwitchTopRequestersResponse = Schema.Array(
  Schema.Struct({ ...TopSongRequester.fields, userId: TwitchStatsViewerId }),
);

/** Schema for one viewer's Keyboard Raffle statistics; encoding rejects non-numeric Viewer IDs before a value is cached. */
export const TwitchRaffleViewerResponse = Schema.Struct({
  ...RaffleLeaderboardEntry.fields,
  userId: TwitchStatsViewerId,
});

const user = { user: Schema.String };

const id = { id: Schema.String };

const name = { name: Schema.String };

const messageResponse = Schema.Struct({ message: Schema.String });

const eventMessageResponse = Schema.Struct({
  ...messageResponse.fields,
  eventId: Schema.String,
  error: Schema.optionalKey(Schema.String),
});

const redirectResponse = HttpApiSchema.WithHeaders(Schema.Void.pipe(HttpApiSchema.status(302)), {
  location: Schema.String,
});

const oauthResponse = Schema.Struct({
  success: Schema.Literal(true),
  message: Schema.String,
  scopes: Schema.Union([Schema.String, Schema.Array(Schema.String)]),
});

const subscriptionSetup = Schema.Struct({
  success: Schema.Literal(true),
  message: Schema.String,
  subscriptions: Schema.Array(TwitchSubscriptionResponse),
  skipped: Schema.Array(subscriptionConfig),
});

const subscriptionList = Schema.Struct({
  subscriptions: Schema.Array(TwitchSubscriptionResponse),
  total: Schema.Int,
});

const subscriptionCleanup = Schema.Struct({
  success: Schema.Boolean,
  message: Schema.String,
  deleted: Schema.Int,
  failed: Schema.Int,
});

const commandSnapshot = Schema.Struct({
  ...ChatCommandDebugSnapshot.fields,
  commands: Schema.Array(
    Schema.Union(
      ChatCommandDefinition.members.map((member) =>
        Schema.Struct({
          ...member.fields,
          value: Schema.NullOr(Schema.String),
          counter: Schema.NullOr(Schema.Int),
        }),
      ),
    ),
  ),
});

/** Schema for the stream reconciliation result; absent Twitch values encode as `null`. */
export const TwitchStreamReconciliationResponse = Schema.Struct({
  /** Transition applied to Stream Lifecycle; `noop` when the stored state already matched Twitch. */
  action: Schema.Literals(["noop", "set_online", "set_offline"]),
  /** Song Queue read after going online; `not_needed` unless the action was `set_online`. */
  queueWarmup: Schema.Literals(["not_needed", "ok", "error"]),
  before: StreamLifecycleState,
  after: StreamLifecycleState,
  twitch: Schema.Struct({
    isLive: Schema.Boolean,
    startedAt: Schema.OptionFromNullOr(Schema.String),
    viewerCount: Schema.OptionFromNullOr(Schema.Number),
    title: Schema.OptionFromNullOr(Schema.String),
    gameName: Schema.OptionFromNullOr(Schema.String),
  }),
});

/** Stream reconciliation result: the action taken, queue warmup outcome, states before and after, and Twitch evidence. */
export type TwitchStreamReconciliationResponse = typeof TwitchStreamReconciliationResponse.Type;

/** Schema for the debug status aggregate; each component reports its own failure, and absent values encode as `null`. */
export const TwitchDebugStatusResponse = Schema.Struct({
  timestamp: Schema.String,
  stream: Schema.Struct({
    ok: Schema.Boolean,
    isLive: Schema.OptionFromNullOr(Schema.Boolean),
    startedAt: Schema.OptionFromNullOr(Schema.String),
    peakViewerCount: Schema.OptionFromNullOr(Schema.Number),
    error: Schema.OptionFromNullOr(Schema.String),
  }),
  twitch: Schema.Struct({
    ok: Schema.Boolean,
    isLive: Schema.OptionFromNullOr(Schema.Boolean),
    startedAt: Schema.OptionFromNullOr(Schema.String),
    viewerCount: Schema.OptionFromNullOr(Schema.Number),
    error: Schema.OptionFromNullOr(Schema.String),
  }),
  songQueue: Schema.Struct({
    ok: Schema.Boolean,
    queueLength: Schema.OptionFromNullOr(Schema.Int),
    error: Schema.OptionFromNullOr(Schema.String),
  }),
});

/** Debug status aggregate of Stream Lifecycle, Twitch, and Song Queue component health. */
export type TwitchDebugStatusResponse = typeof TwitchDebugStatusResponse.Type;

/** Schema for the `!stats` preview diagnostics; each component reports its own failure, and absent values encode as `null`. */
export const TwitchViewerStatsDebugResponse = Schema.Struct({
  /** Display name after trimming whitespace and leading `@`. */
  targetUser: Schema.String,
  /** True only when every component succeeded and found no songs, unlocks, or rolls. */
  noStatsForTargetUser: Schema.Boolean,
  /** Exact text `!stats` would send to chat. */
  chatMessage: Schema.String,
  components: Schema.Struct({
    song: Schema.Struct({
      status: Schema.Literals(["ok", "error"]),
      count: Schema.OptionFromNullOr(Schema.Int),
      error: Schema.OptionFromNullOr(Schema.String),
    }),
    achievements: Schema.Struct({
      status: Schema.Literals(["ok", "error"]),
      unlockedCount: Schema.OptionFromNullOr(Schema.Int),
      definitionsCount: Schema.OptionFromNullOr(Schema.Int),
      error: Schema.OptionFromNullOr(Schema.String),
    }),
    raffle: Schema.Struct({
      status: Schema.Literals(["ok", "error"]),
      notFound: Schema.Boolean,
      stats: Schema.String,
      error: Schema.OptionFromNullOr(Schema.String),
    }),
  }),
});

/** `!stats` preview diagnostics for one viewer, with per-component status. */
export type TwitchViewerStatsDebugResponse = typeof TwitchViewerStatsDebugResponse.Type;

/** Endpoint group for health, Song Queue, and Achievements reads; its URLs stay unversioned for overlay and client compatibility. */
export const TwitchPublicApi = HttpApiGroup.make("public")
  .add(
    HttpApiEndpoint.get("health", "/health", {
      success: Schema.Struct({ status: Schema.Literal("ok") }),
    }),
  )
  .add(
    HttpApiEndpoint.get("nowPlaying", "/api/now-playing", {
      ...json,
      success: TwitchNowPlayingResponse,
    }),
  )
  .add(
    HttpApiEndpoint.get("queue", "/api/queue", { ...json, success: SongQueueResult }).annotateMerge(
      limitQuery,
    ),
  )
  .add(
    HttpApiEndpoint.get("requestHistory", "/api/song-requests/history", {
      ...json,
      success: RequestHistoryResult,
    }).annotateMerge(limitQuery),
  )
  .add(
    HttpApiEndpoint.get("achievementDefinitions", "/api/achievements/definitions", {
      ...json,
      success: Schema.Array(AchievementDefinition),
    }),
  )
  .add(
    HttpApiEndpoint.get("achievementLeaderboard", "/api/achievements/leaderboard", {
      ...json,
      success: Schema.Array(AchievementLeaderboardEntry),
    }).annotateMerge(limitQuery),
  )
  .add(
    HttpApiEndpoint.get("viewerAchievements", "/api/achievements/:user", {
      ...json,
      success: Schema.Array(ViewerAchievementProgress),
      params: user,
    }),
  )
  .add(
    HttpApiEndpoint.get("viewerUnlockedAchievements", "/api/achievements/:user/unlocked", {
      ...json,
      success: Schema.Array(UnlockedAchievement),
      params: user,
    }),
  );

/** Endpoint group for public Song Request and Keyboard Raffle statistics, cached for sixty seconds under canonical keys. */
export const TwitchStatsApi = HttpApiGroup.make("stats")
  .add(
    HttpApiEndpoint.get("topTracks", "/api/stats/top-tracks", {
      ...json,
      success: Schema.Array(TopRequestedTrack),
    }).annotateMerge(limitQuery),
  )
  .add(
    HttpApiEndpoint.get("viewerTopTracks", "/api/stats/top-tracks/:user", {
      ...json,
      success: Schema.Array(TopRequestedTrack),
      params: user,
    }).annotateMerge(viewerTopTracksQuery),
  )
  .add(
    HttpApiEndpoint.get("topRequesters", "/api/stats/top-requesters", {
      ...json,
      success: TwitchTopRequestersResponse,
    }).annotateMerge(limitQuery),
  )
  .add(
    HttpApiEndpoint.get("raffleLeaderboard", "/api/stats/raffle/leaderboard", {
      ...json,
      success: Schema.Array(TwitchRaffleViewerResponse),
    }).annotateMerge(leaderboardQuery),
  )
  .add(
    HttpApiEndpoint.get("raffleViewer", "/api/stats/raffle/user/:user", {
      ...json,
      success: TwitchRaffleViewerResponse,
      params: user,
    }),
  );

/** Endpoint group for Event Bus, Achievements, and Chat Commands administration, authenticated by the administrator bearer token. */
export const TwitchAdminApi = HttpApiGroup.make("admin")
  .add(
    HttpApiEndpoint.get("deadLetters", "/api/admin/dlq", {
      ...json,
      success: DeadLetterEventList,
    }).annotateMerge(pageQuery),
  )
  .add(
    HttpApiEndpoint.get("pendingEvents", "/api/admin/event-bus/pending", {
      ...json,
      success: PendingEventList,
    }).annotateMerge(pageQuery),
  )
  .add(
    HttpApiEndpoint.post("replayDeadLetter", "/api/admin/dlq/:id/replay", {
      ...json,
      success: eventMessageResponse,
      params: id,
    }),
  )
  .add(
    HttpApiEndpoint.delete("deleteDeadLetter", "/api/admin/dlq/:id", {
      ...json,
      success: eventMessageResponse,
      params: id,
    }),
  )
  .add(
    HttpApiEndpoint.post("resetAchievements", "/api/admin/achievements/reset-one-time", {
      ...json,
      success: Schema.Struct({
        message: Schema.String,
        deleted: Schema.Int,
        achievementIds: Schema.Array(Schema.String),
        user: Schema.String,
      }),
    }),
  )
  .add(
    HttpApiEndpoint.get("achievementCounts", "/api/admin/achievements/debug/counts", {
      ...json,
      success: AchievementDebugTableCounts,
    }),
  )
  .add(
    HttpApiEndpoint.get("achievementSnapshot", "/api/admin/achievements/debug/user/:user", {
      ...json,
      success: AchievementDebugUserSnapshot,
      params: user,
    }),
  )
  .add(
    HttpApiEndpoint.get("commands", "/api/admin/commands", {
      ...json,
      success: Schema.Array(ChatCommandDefinition),
    }),
  )
  .add(
    HttpApiEndpoint.post("createCommand", "/api/admin/commands", {
      ...json,
      success: ChatCommandDefinition.pipe(HttpApiSchema.status(201)),
      payload: CreateChatCommandInput,
    }),
  )
  .add(
    HttpApiEndpoint.patch("updateCommand", "/api/admin/commands/:name", {
      ...json,
      success: ChatCommandDefinition,
      params: name,
      payload: UpdateChatCommandInput,
    }),
  )
  .add(
    HttpApiEndpoint.delete("deleteCommand", "/api/admin/commands/:name", {
      ...json,
      success: Schema.Struct({ message: Schema.String, command: Schema.String }),
      params: name,
    }),
  )
  .add(
    HttpApiEndpoint.get("commandsSnapshot", "/api/admin/commands/debug/snapshot", {
      ...json,
      success: commandSnapshot,
    }),
  )
  .add(
    HttpApiEndpoint.get("viewerStatsDebug", "/api/admin/debug/stats/:user", {
      ...json,
      success: TwitchViewerStatsDebugResponse,
      params: user,
    }),
  )
  .annotateEndpointsMerge(administratorSecurityTransform);

/** Endpoint group for authenticated Stream Lifecycle and Keyboard Raffle diagnostics and stream reconciliation. */
export const TwitchDebugApi = HttpApiGroup.make("debug")
  .add(
    HttpApiEndpoint.get("streamState", "/api/debug/stream-state", {
      ...json,
      success: StreamLifecycleState,
    }),
  )
  .add(
    HttpApiEndpoint.get("raffleLeaderboardDebug", "/api/debug/keyboard-raffle/leaderboard", {
      ...json,
      success: Schema.Array(RaffleLeaderboardEntry),
    }).annotateMerge(leaderboardQuery),
  )
  .add(
    HttpApiEndpoint.post("reconcileStream", "/api/debug/reconcile-stream-state", {
      ...json,
      success: TwitchStreamReconciliationResponse,
    }),
  )
  .add(
    HttpApiEndpoint.get("debugStatus", "/api/debug/status", {
      ...json,
      success: TwitchDebugStatusResponse,
    }),
  )
  .annotateEndpointsMerge(administratorSecurityTransform);

/** Endpoint group for Spotify and Twitch OAuth; authorization requires the setup header and callbacks consume durable one-use state. */
export const TwitchOAuthApi = HttpApiGroup.make("oauth")
  .add(
    HttpApiEndpoint.get("spotifyAuthorize", "/oauth/spotify/authorize", {
      ...json,
      success: redirectResponse,
    }).annotateMerge(setupSecurity),
  )
  .add(
    HttpApiEndpoint.get("spotifyCallback", "/oauth/spotify/callback", {
      ...json,
      success: oauthResponse,
    }).annotateMerge(callbackQuery),
  )
  .add(
    HttpApiEndpoint.get("twitchAuthorize", "/oauth/twitch/authorize", {
      ...json,
      success: redirectResponse,
    }).annotateMerge(setupSecurity),
  )
  .add(
    HttpApiEndpoint.get("twitchCallback", "/oauth/twitch/callback", {
      ...json,
      success: oauthResponse,
    }).annotateMerge(callbackQuery),
  );

/** Endpoint group for the signed EventSub webhook and authenticated subscription management. */
export const TwitchEventSubApi = HttpApiGroup.make("eventsub")
  .add(
    HttpApiEndpoint.post("webhook", "/webhooks/twitch", {
      ...json,
      success: [
        Schema.Struct({ success: Schema.Literal(true) }),
        Schema.String.pipe(HttpApiSchema.asText()),
      ],
      payload: Schema.Json,
    }).annotateMerge(webhookHeaders),
  )
  .add(
    HttpApiEndpoint.post("setupSubscriptions", "/eventsub/setup", {
      ...json,
      success: subscriptionSetup,
    }).annotateMerge(administratorSecurity),
  )
  .add(
    HttpApiEndpoint.get("listSubscriptions", "/eventsub/list", {
      ...json,
      success: subscriptionList,
    }).annotateMerge(administratorSecurity),
  )
  .add(
    HttpApiEndpoint.delete("deleteSubscription", "/eventsub/:id", {
      ...json,
      success: Schema.Struct({ success: Schema.Boolean, message: Schema.String }),
      params: id,
    }).annotateMerge(administratorSecurity),
  )
  .add(
    HttpApiEndpoint.post("cleanupSubscriptions", "/eventsub/cleanup", {
      ...json,
      success: subscriptionCleanup,
    }).annotateMerge(administratorSecurity),
  );

/** Endpoint group for the unauthenticated OBS Now Playing overlay, which polls only same-origin APIs. */
export const TwitchOverlayApi = HttpApiGroup.make("overlay").add(
  HttpApiEndpoint.get("nowPlayingOverlay", "/overlay/now-playing", {
    success: Schema.String.pipe(HttpApiSchema.asText({ contentType: "text/html" })),
  }),
);

/** Public Worker API definition, used both to generate OpenAPI and to register executable routes. */
export class TwitchHttpApi extends HttpApi.make("TwitchHttpApi")
  .add(
    TwitchPublicApi,
    TwitchStatsApi,
    TwitchAdminApi,
    TwitchDebugApi,
    TwitchOAuthApi,
    TwitchEventSubApi,
    TwitchOverlayApi,
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "CF Twitch API",
      version: "1.0.0",
      description:
        "Existing Worker URLs are preserved for compatibility. Durable Object APIs are separately versioned.",
    }),
  ) {}

/** Generates the public OpenAPI document while preserving all framework-generated metadata. */
export const generateTwitchOpenApi = (): OpenApi.OpenAPISpec => {
  const openApi = OpenApi.fromApi(TwitchHttpApi);

  return {
    ...openApi,
    components: {
      ...openApi.components,
      securitySchemes: {
        ...openApi.components.securitySchemes,
        AdministratorBearer: { type: "http", scheme: "bearer" },
        OAuthSetupHeader: { type: "apiKey", in: "header", name: "x-setup-secret" },
      },
    },
  };
};
