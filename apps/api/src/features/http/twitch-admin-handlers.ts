import { Effect, Option, Schema } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import { HttpServerRequest, HttpServerResponse } from "effect/http";
import { TwitchHttpApi, type TwitchHttpOperation } from "@cf-twitch/contracts/twitch-api";
import { EventId } from "@cf-twitch/contracts/identity";
import { DeadLetterEventList, PendingEventList } from "@cf-twitch/contracts/event-bus";
import {
  AchievementDebugTableCounts,
  AchievementDebugUserSnapshot,
} from "@cf-twitch/contracts/achievement";
import {
  ChatCommandDebugSnapshot,
  ChatCommandDefinition,
  type ChatCommandName,
  parseChatCommandName,
  CreateChatCommandInput,
  UpdateChatCommandInput,
} from "@cf-twitch/contracts/chat-command";
import { TwitchConfiguration } from "../../runtime/twitch-configuration.ts";
import { Commands } from "../commands/commands.ts";
import { EventBusAdministration } from "../events/event-bus-service.ts";
import { Achievements } from "../achievements/achievements-service.ts";
import { SongQueue } from "../song-queue/song-queue.ts";
import { Raffle } from "../raffle/raffle-service.ts";
import {
  HttpBoundaryError,
  encodeHttpResponse,
  handleHttpBoundary,
  invalidHttpServiceResponse,
  parseHttpAdminPageQuery,
  requireHttpAdministrator,
} from "./http-boundary.ts";
import {
  achievementHttpFailure,
  commandsHttpFailureHandlers,
  eventBusHttpFailure,
  type HttpServiceAccess,
} from "./http-service-failures.ts";
import { readViewerStatsDebug } from "./viewer-stats-debug.ts";
import { formatHttpCommandIssues } from "./http-validation-issues.ts";

const decodeCreateCommand = Schema.decodeEffect(Schema.toCodecJson(CreateChatCommandInput), {
  errors: "all",
  onExcessProperty: "error",
});

const decodeUpdateCommand = Schema.decodeEffect(Schema.toCodecJson(UpdateChatCommandInput), {
  errors: "all",
  onExcessProperty: "error",
});

const decodeEventId = Schema.decodeEffect(EventId);

const invalidCommandPayload = (
  summary: "Invalid command payload" | "Invalid command patch",
  error: Schema.SchemaError,
  payload: Schema.Json,
) =>
  new HttpBoundaryError({
    operation: "parseBody",
    status: 400,
    failure: {
      code: "InvalidCommandPayload",
      error: summary,
      message:
        "Invalid command payload: one or more command fields are missing, unknown, or invalid. Fix the fields listed in details and send the request again.",
      details: formatHttpCommandIssues(error, payload),
      retryable: false,
    },
  });

/**
 * Parses an administrator event ID route segment.
 *
 * @returns The Event ID, or fails with `HttpBoundaryError` (`InvalidEventId`, 400) when it is not a UUID.
 */
const parseHttpEventId = (id: string): Effect.Effect<EventId, HttpBoundaryError> =>
  decodeEventId(id).pipe(
    Effect.mapError(
      () =>
        new HttpBoundaryError({
          operation: "parsePath",
          status: 400,
          failure: {
            code: "InvalidEventId",
            error: "Invalid event ID",
            message: `Invalid event ID ${JSON.stringify(id)}: Event Bus event IDs are UUIDs. Check the ID with GET /api/admin/dlq and try again.`,
            details: { eventId: id },
            retryable: false,
          },
        }),
    ),
  );

/**
 * Parses an administrator command name route segment.
 *
 * @returns The canonical command name, or fails with `HttpBoundaryError` (`InvalidCommandNameError`, 400).
 */
const parseHttpCommandName = (name: string): Effect.Effect<ChatCommandName, HttpBoundaryError> =>
  parseChatCommandName(name).pipe(
    Effect.mapError(
      () =>
        new HttpBoundaryError({
          operation: "parsePath",
          status: 400,
          failure: {
            code: "InvalidCommandNameError",
            error: "Invalid command name",
            message: `Invalid command name ${JSON.stringify(name)}: use a canonical command name without the leading "!". Fix the path and try again.`,
            details: { commandName: name },
            retryable: false,
          },
        }),
    ),
  );

const readCommandJson = HttpServerRequest.schemaBodyJson(Schema.Json).pipe(
  Effect.mapError(
    () =>
      new HttpBoundaryError({
        operation: "readBody",
        status: 400,
        failure: {
          code: "InvalidJsonBody",
          error: "Invalid JSON body",
          message:
            "Invalid JSON body: the request body is not finite JSON. Send a JSON object and try again.",
          details: {},
          retryable: false,
        },
      }),
  ),
);

const commandChange = (summary: string): HttpServiceAccess => ({
  kind: "change",
  summary,
  reconcile: "Check the commands with GET /api/admin/commands before retrying.",
});

/**
 * Layer that serves administrator Event Bus, Achievements and Chat Commands endpoints.
 *
 * **Details**
 *
 * Every endpoint authenticates the administrator bearer token before reading its body or query.
 * Missing resources return 404 and name or alias conflicts return 409. A change whose service
 * became unavailable reports `OutcomeUnknown` and names the read that reconciles it.
 */
export const twitchAdminHandlersLayer = HttpApiBuilder.group(TwitchHttpApi, "admin", (handlers) =>
  Effect.gen(function* () {
    const configuration = yield* TwitchConfiguration;
    const commands = yield* Commands;
    const eventBus = yield* EventBusAdministration;
    const achievements = yield* Achievements;
    const songQueue = yield* SongQueue;
    const raffle = yield* Raffle;

    const admin = <R>(
      operation: TwitchHttpOperation,
      effect: Effect.Effect<HttpServerResponse.HttpServerResponse, HttpBoundaryError, R>,
    ) =>
      requireHttpAdministrator(configuration.administratorSecret, "Admin API").pipe(
        Effect.andThen(effect),
        handleHttpBoundary(operation),
      );

    return handlers
      .handleRaw("deadLetters", () =>
        admin(
          "deadLetters",
          Effect.gen(function* () {
            const { limit, offset } = yield* parseHttpAdminPageQuery();

            const value = yield* eventBus.listDeadLetters({ limit, offset }).pipe(
              Effect.catchTag("EventBusError", (error) =>
                Effect.fail(
                  eventBusHttpFailure(error, {
                    kind: "repeatable",
                    summary: "Failed to fetch DLQ",
                  }),
                ),
              ),
            );

            return yield* encodeHttpResponse("eventBus", DeadLetterEventList, value);
          }),
        ),
      )
      .handleRaw("pendingEvents", () =>
        admin(
          "pendingEvents",
          Effect.gen(function* () {
            const { limit, offset } = yield* parseHttpAdminPageQuery();

            const value = yield* eventBus.listPending({ limit, offset }).pipe(
              Effect.catchTag("EventBusError", (error) =>
                Effect.fail(
                  eventBusHttpFailure(error, {
                    kind: "repeatable",
                    summary: "Failed to fetch pending events",
                  }),
                ),
              ),
            );

            return yield* encodeHttpResponse("eventBus", PendingEventList, value);
          }),
        ),
      )
      .handleRaw("replayDeadLetter", ({ params }) =>
        admin(
          "replayDeadLetter",
          Effect.gen(function* () {
            const eventId = yield* parseHttpEventId(params.id);

            const value = yield* eventBus.replayDeadLetter({ eventId }).pipe(
              Effect.catchTag("EventBusError", (error) =>
                Effect.fail(
                  eventBusHttpFailure(error, {
                    kind: "change",
                    summary: "Failed to replay DLQ item",
                    reconcile:
                      "Check whether the event remains in GET /api/admin/dlq before retrying.",
                  }),
                ),
              ),
            );

            if (value.success)
              return HttpServerResponse.jsonUnsafe({
                message: "Event replayed successfully",
                eventId: value.eventId,
              });

            return HttpServerResponse.jsonUnsafe(
              Option.match(value.error, {
                onNone: () => ({
                  message: "Replay failed - event remains in DLQ",
                  eventId: value.eventId,
                }),
                onSome: (error) => ({
                  message: "Replay failed - event remains in DLQ",
                  eventId: value.eventId,
                  error,
                }),
              }),
            );
          }),
        ),
      )
      .handleRaw("deleteDeadLetter", ({ params }) =>
        admin(
          "deleteDeadLetter",
          Effect.gen(function* () {
            const eventId = yield* parseHttpEventId(params.id);

            yield* eventBus.deleteDeadLetter({ eventId }).pipe(
              Effect.catchTag("EventBusError", (error) =>
                Effect.fail(
                  eventBusHttpFailure(error, {
                    kind: "change",
                    summary: "Failed to delete DLQ item",
                    reconcile:
                      "Check whether the event remains in GET /api/admin/dlq before retrying.",
                  }),
                ),
              ),
            );

            return HttpServerResponse.jsonUnsafe({ message: "Event deleted from DLQ", eventId });
          }),
        ),
      )
      .handleRaw("resetAchievements", () =>
        admin(
          "resetAchievements",
          Effect.gen(function* () {
            const request = yield* HttpServerRequest.HttpServerRequest;

            const user = Option.fromNullishOr(
              new URL(request.originalUrl).searchParams.get("user"),
            );

            if (Option.isSome(user) && user.value.trim().length === 0)
              return yield* Effect.fail(
                new HttpBoundaryError({
                  operation: "parseQuery",
                  status: 400,
                  failure: {
                    code: "InvalidViewerDisplayName",
                    error: "Viewer display name must not be empty",
                    message:
                      'Viewer display name must not be empty: the "user" query parameter is blank. Send a display name, or omit "user" to reset every viewer.',
                    details: { parameter: "user" },
                    retryable: false,
                  },
                }),
              );

            const value = yield* achievements
              .resetOneTimeAchievements({ userDisplayName: user })
              .pipe(
                Effect.catchTag("AchievementError", (error) =>
                  Effect.fail(
                    achievementHttpFailure(error, {
                      kind: "change",
                      summary: "Failed to reset achievements",
                      reconcile:
                        "Check the counts with GET /api/admin/achievements/debug/counts before retrying.",
                    }),
                  ),
                ),
              );

            if (Option.isSome(user) && value.deleted === 0)
              return yield* Effect.fail(
                new HttpBoundaryError({
                  operation: "callService",
                  status: 404,
                  failure: {
                    code: "ViewerAchievementsNotFound",
                    error: "User not found or no one-time achievements to reset",
                    message: `Viewer achievements not found: ${user.value} has no one-time achievements to reset. Check the display name and try again.`,
                    details: { user: user.value },
                    retryable: false,
                  },
                }),
              );

            return HttpServerResponse.jsonUnsafe({
              message: "One-time achievements reset",
              deleted: value.deleted,
              achievementIds: value.achievementIds,
              user: Option.getOrElse(user, () => "all"),
            });
          }),
        ),
      )
      .handleRaw("achievementCounts", () =>
        admin(
          "achievementCounts",
          achievements.getDebugTableCounts().pipe(
            Effect.catchTag("AchievementError", (error) =>
              Effect.fail(
                achievementHttpFailure(error, {
                  kind: "repeatable",
                  summary: "Failed to fetch achievements debug counts",
                }),
              ),
            ),
            Effect.flatMap((value) =>
              encodeHttpResponse("achievements", AchievementDebugTableCounts, value),
            ),
          ),
        ),
      )
      .handleRaw("achievementSnapshot", ({ params }) =>
        admin(
          "achievementSnapshot",
          achievements.getDebugUserSnapshot({ userDisplayName: params.user }).pipe(
            Effect.catchTag("AchievementError", (error) =>
              Effect.fail(
                achievementHttpFailure(error, {
                  kind: "repeatable",
                  summary: "Failed to fetch user debug snapshot",
                }),
              ),
            ),
            Effect.flatMap((value) =>
              encodeHttpResponse("achievements", AchievementDebugUserSnapshot, value),
            ),
          ),
        ),
      )
      .handleRaw("commands", () =>
        admin(
          "commands",
          commands.getAllCommands().pipe(
            Effect.catchTags(
              commandsHttpFailureHandlers({
                kind: "repeatable",
                summary: "Failed to list commands",
              }),
            ),
            Effect.flatMap((value) =>
              encodeHttpResponse("chatCommands", Schema.Array(ChatCommandDefinition), value),
            ),
          ),
        ),
      )
      .handleRaw("createCommand", () =>
        admin(
          "createCommand",
          Effect.gen(function* () {
            const payload = yield* readCommandJson;

            const input = yield* decodeCreateCommand(payload).pipe(
              Effect.mapError((error) =>
                invalidCommandPayload("Invalid command payload", error, payload),
              ),
            );

            const value = yield* commands
              .createCommand(input)
              .pipe(
                Effect.catchTags(
                  commandsHttpFailureHandlers(commandChange("Failed to create command")),
                ),
              );

            return yield* encodeHttpResponse("chatCommands", ChatCommandDefinition, value, 201);
          }),
        ),
      )
      .handleRaw("updateCommand", ({ params }) =>
        admin(
          "updateCommand",
          Effect.gen(function* () {
            const payload = yield* readCommandJson;

            const patch = yield* decodeUpdateCommand(payload).pipe(
              Effect.mapError((error) =>
                invalidCommandPayload("Invalid command patch", error, payload),
              ),
            );

            const name = yield* parseHttpCommandName(params.name);

            const value = yield* commands
              .updateCommand({ name, patch })
              .pipe(
                Effect.catchTags(
                  commandsHttpFailureHandlers(commandChange("Failed to update command")),
                ),
              );

            return yield* encodeHttpResponse("chatCommands", ChatCommandDefinition, value);
          }),
        ),
      )
      .handleRaw("deleteCommand", ({ params }) =>
        admin(
          "deleteCommand",
          Effect.gen(function* () {
            const name = yield* parseHttpCommandName(params.name);

            yield* commands
              .deleteCommand({ name })
              .pipe(
                Effect.catchTags(
                  commandsHttpFailureHandlers(commandChange("Failed to delete command")),
                ),
              );

            return HttpServerResponse.jsonUnsafe({
              message: "Command deleted",
              command: params.name,
            });
          }),
        ),
      )
      .handleRaw("commandsSnapshot", () =>
        admin(
          "commandsSnapshot",
          Effect.gen(function* () {
            const value = yield* commands.getDebugSnapshot().pipe(
              Effect.catchTags(
                commandsHttpFailureHandlers({
                  kind: "repeatable",
                  summary: "Failed to fetch commands debug snapshot",
                }),
              ),
            );

            const encoded = yield* Schema.encodeEffect(ChatCommandDebugSnapshot)(value).pipe(
              Effect.mapError(() => invalidHttpServiceResponse("encodeResponse", "chatCommands")),
            );

            return HttpServerResponse.jsonUnsafe({
              ...encoded,
              commands: encoded.commands.map(({ command, value, counter }) => ({
                ...command,
                value,
                counter,
              })),
            });
          }),
        ),
      )
      .handleRaw("viewerStatsDebug", ({ params }) =>
        admin(
          "viewerStatsDebug",
          readViewerStatsDebug(params.user).pipe(
            Effect.provideService(Achievements, achievements),
            Effect.provideService(SongQueue, songQueue),
            Effect.provideService(Raffle, raffle),
          ),
        ),
      );
  }),
);
