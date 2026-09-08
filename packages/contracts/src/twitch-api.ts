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
import { ProviderEventSubSubscription } from "./provider.ts";
import { ViewerId } from "./identity.ts";
import {
  HttpApi,
  HttpApiEndpoint,
  HttpApiGroup,
  HttpApiSchema,
  OpenApi,
} from "effect/unstable/httpapi";

/** Existing public error envelope; status is selected by the HTTP boundary. */
export const TwitchHttpError = Schema.Struct({
  error: Schema.String,
  code: Schema.optionalKey(Schema.String),
  details: Schema.optionalKey(Schema.Json),
});
const errors = [400, 401, 403, 404, 409, 413, 500, 502, 503].map((status) =>
  TwitchHttpError.pipe(HttpApiSchema.status(status)),
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
    "Raw body is bounded to 1 MiB and decoded with fatal UTF-8. Require timestamp within ±10 minutes and HMAC-SHA256(messageId + timestamp + exact body bytes) before JSON parsing. Header/body subscription type and version must agree. Conflicting message content returns 503.",
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
const setupSecurity = OpenApi.annotations({ override: { security: [{ OAuthSetupHeader: [] }] } });
const json = { success: Schema.Json, error: errors };
/** External now playing absence encodes as null rather than an Effect Option object. */
export const TwitchNowPlayingResponse = Schema.Struct({
  track: Schema.OptionFromNullOr(QueuedTrack),
  position: Schema.Literal(0),
});
/** Public stats viewer IDs retain the historical numeric-only boundary. */
export const TwitchStatsViewerId = ViewerId.check(Schema.isPattern(/^\d{1,20}$/u));
/** Stats response encoding also validates numeric viewer identities before caching. */
export const TwitchTopRequestersResponse = Schema.Array(
  Schema.Struct({ ...TopSongRequester.fields, userId: TwitchStatsViewerId }),
);
/** Public raffle stats reject invalid service viewer identities before returning cacheable data. */
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
/** Public subscription evidence omits absent callback keys, as Twitch management clients expect. */
export const TwitchSubscriptionResponse = Schema.Struct({
  ...ProviderEventSubSubscription.fields,
  transport: Schema.Struct({
    method: Schema.String,
    callback: Schema.OptionFromOptionalKey(Schema.String),
  }),
});
const subscriptionConfig = Schema.Struct({
  type: Schema.String,
  version: Schema.String,
  condition: Schema.Record(Schema.String, Schema.String),
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
const reconciliationResponse = Schema.Struct({
  action: Schema.Literals(["noop", "set_online", "set_offline"]),
  queueWarmup: Schema.Literals(["not_needed", "ok", "error"]),
  before: StreamLifecycleState,
  after: StreamLifecycleState,
  twitch: Schema.Struct({
    isLive: Schema.Boolean,
    startedAt: Schema.NullOr(Schema.String),
    viewerCount: Schema.NullOr(Schema.Number),
    title: Schema.NullOr(Schema.String),
    gameName: Schema.NullOr(Schema.String),
  }),
});
const statusResponse = Schema.Struct({
  timestamp: Schema.String,
  stream: Schema.Struct({
    ok: Schema.Boolean,
    isLive: Schema.NullOr(Schema.Boolean),
    startedAt: Schema.NullOr(Schema.String),
    peakViewerCount: Schema.NullOr(Schema.Number),
    error: Schema.NullOr(Schema.String),
  }),
  twitch: Schema.Struct({
    ok: Schema.Boolean,
    isLive: Schema.NullOr(Schema.Boolean),
    startedAt: Schema.NullOr(Schema.String),
    viewerCount: Schema.NullOr(Schema.Number),
    error: Schema.NullOr(Schema.String),
  }),
  songQueue: Schema.Struct({
    ok: Schema.Boolean,
    queueLength: Schema.NullOr(Schema.Int),
    error: Schema.NullOr(Schema.String),
  }),
});
const viewerStatsResponse = Schema.Struct({
  targetUser: Schema.String,
  noStatsForTargetUser: Schema.Boolean,
  chatMessage: Schema.String,
  components: Schema.Struct({
    song: Schema.Struct({
      status: Schema.Literals(["ok", "error"]),
      count: Schema.NullOr(Schema.Int),
      error: Schema.NullOr(Schema.String),
    }),
    achievements: Schema.Struct({
      status: Schema.Literals(["ok", "error"]),
      unlockedCount: Schema.NullOr(Schema.Int),
      definitionsCount: Schema.NullOr(Schema.Int),
      error: Schema.NullOr(Schema.String),
    }),
    raffle: Schema.Struct({
      status: Schema.Literals(["ok", "error"]),
      notFound: Schema.Boolean,
      stats: Schema.String,
      error: Schema.NullOr(Schema.String),
    }),
  }),
});

/** Public data URLs intentionally remain unversioned for overlay/client compatibility. */
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

/** Public statistics preserve canonical query keys and a sixty second cache lifetime. */
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

/** Privileged commands and diagnostics require the administrator bearer secret. */
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
      success: viewerStatsResponse,
      params: user,
    }),
  );

/** Stream reconciliation and diagnostics retain their existing authenticated URLs. */
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
      success: reconciliationResponse,
    }),
  )
  .add(
    HttpApiEndpoint.get("debugStatus", "/api/debug/status", { ...json, success: statusResponse }),
  );

/** Provider OAuth callbacks use durable one-use state, never a query setup secret. */
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

/** Twitch webhook raw bytes are authenticated before payload decoding or durable acceptance. */
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

/** OBS overlay HTML does not require authentication and polls only same-origin APIs. */
export const TwitchOverlayApi = HttpApiGroup.make("overlay").add(
  HttpApiEndpoint.get("nowPlayingOverlay", "/overlay/now-playing", {
    success: Schema.String.pipe(HttpApiSchema.asText({ contentType: "text/html" })),
  }),
);

/** OpenAPI generation input and executable route inventory for the public Worker. */
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

const openApiMethodNames = [
  "get",
  "put",
  "post",
  "delete",
  "options",
  "head",
  "patch",
  "trace",
] satisfies ReadonlyArray<OpenApi.OpenAPISpecMethodName>;

const addAdministratorOpenApiSecurity = (openApi: OpenApi.OpenAPISpec): void => {
  for (const [path, pathItem] of Object.entries(openApi.paths)) {
    if (!path.startsWith("/api/admin/") && !path.startsWith("/api/debug/")) continue;
    for (const method of openApiMethodNames) {
      const operation = pathItem[method];
      if (operation !== undefined) operation.security = administratorSecurityRequirements;
    }
  }
};

/** Generates the public OpenAPI document while preserving all framework-generated metadata. */
export const generateTwitchOpenApi = (): OpenApi.OpenAPISpec => {
  const openApi = OpenApi.fromApi(TwitchHttpApi);
  addAdministratorOpenApiSecurity(openApi);
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
