import { Effect, Option, Schema } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { TwitchHttpApi } from "@cf-twitch/contracts/twitch-api";
import { EventId } from "@cf-twitch/contracts/identity";
import {
  DeadLetterEventList,
  PendingEventList,
  type EventBusError,
} from "@cf-twitch/contracts/event-bus";
import {
  AchievementDebugTableCounts,
  AchievementDebugUserSnapshot,
} from "@cf-twitch/contracts/achievement";
import {
  ChatCommandDebugSnapshot,
  ChatCommandDefinition,
  parseChatCommandName,
  CreateChatCommandInput,
  UpdateChatCommandInput,
  type CommandsError,
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
  parseHttpAdminPageQuery,
  requireHttpAdministrator,
} from "./http-boundary.ts";
import { readViewerStatsDebug } from "./viewer-stats-debug.ts";
import { formatHttpCommandIssues } from "./http-validation-issues.ts";

const parseCreateCommand = Schema.decodeEffect(Schema.toCodecJson(CreateChatCommandInput), {
  errors: "all",
  onExcessProperty: "error",
});
const parseUpdateCommand = Schema.decodeEffect(Schema.toCodecJson(UpdateChatCommandInput), {
  errors: "all",
  onExcessProperty: "error",
});
const parseCommandJson = Schema.decodeUnknownEffect(Schema.Json);

const parseEventId = Schema.decodeEffect(EventId);
const failure = (error: string) => () => new HttpBoundaryError({ status: 500, error });
const commandFailure = (operation: "create" | "update" | "delete") => (error: CommandsError) => {
  switch (error._tag) {
    case "CommandAlreadyExistsError":
    case "CommandAliasConflictError":
      return new HttpBoundaryError({ status: 409, error: error.message, code: error._tag });
    case "CommandNotFoundError":
      return new HttpBoundaryError({ status: 404, error: error.message, code: error._tag });
    case "CommandInputParseError":
    case "CommandInvalidDefinitionError":
      return new HttpBoundaryError({ status: 400, error: error.message, code: error._tag });
    default:
      return new HttpBoundaryError({ status: 500, error: `Failed to ${operation} command` });
  }
};
const deadLetterFailure = (operation: "replay" | "delete") => (error: EventBusError) =>
  new HttpBoundaryError({
    status: error.reason === "event_not_found" ? 404 : 500,
    error:
      error.reason === "event_not_found"
        ? `DLQ item not found: ${Option.getOrElse(error.eventId, () => "unknown")}`
        : `Failed to ${operation} DLQ item`,
  });
const readCommandJson = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  return yield* request.json.pipe(
    Effect.flatMap(parseCommandJson),
    Effect.mapError(() => new HttpBoundaryError({ status: 400, error: "Invalid JSON body" })),
  );
});

/** Administrative handlers authenticate before body parsing and preserve conflict/not-found status codes. */
export const twitchAdminHandlersLayer = HttpApiBuilder.group(TwitchHttpApi, "admin", (handlers) =>
  Effect.gen(function* () {
    const configuration = yield* TwitchConfiguration;
    const commands = yield* Commands;
    const eventBus = yield* EventBusAdministration;
    const achievements = yield* Achievements;
    const songQueue = yield* SongQueue;
    const raffle = yield* Raffle;
    const admin = <R>(
      effect: Effect.Effect<HttpServerResponse.HttpServerResponse, HttpBoundaryError, R>,
    ) =>
      requireHttpAdministrator(configuration.administratorSecret, "Admin API").pipe(
        Effect.andThen(effect),
        handleHttpBoundary,
      );
    return handlers
      .handleRaw("deadLetters", () =>
        admin(
          Effect.gen(function* () {
            const { limit, offset } = yield* parseHttpAdminPageQuery();
            const value = yield* eventBus
              .listDeadLetters({ limit, offset })
              .pipe(Effect.mapError(failure("Failed to fetch DLQ")));
            return yield* encodeHttpResponse(DeadLetterEventList, value);
          }),
        ),
      )
      .handleRaw("pendingEvents", () =>
        admin(
          Effect.gen(function* () {
            const { limit, offset } = yield* parseHttpAdminPageQuery();
            const value = yield* eventBus
              .listPending({ limit, offset })
              .pipe(Effect.mapError(failure("Failed to fetch pending events")));
            return yield* encodeHttpResponse(PendingEventList, value);
          }),
        ),
      )
      .handleRaw("replayDeadLetter", ({ params }) =>
        admin(
          Effect.gen(function* () {
            const eventId = yield* parseEventId(params.id).pipe(
              Effect.mapError(
                () => new HttpBoundaryError({ status: 400, error: "Invalid event ID" }),
              ),
            );
            const value = yield* eventBus
              .replayDeadLetter({ eventId })
              .pipe(Effect.mapError(deadLetterFailure("replay")));
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
          Effect.gen(function* () {
            const eventId = yield* parseEventId(params.id).pipe(
              Effect.mapError(
                () => new HttpBoundaryError({ status: 400, error: "Invalid event ID" }),
              ),
            );
            yield* eventBus
              .deleteDeadLetter({ eventId })
              .pipe(Effect.mapError(deadLetterFailure("delete")));
            return HttpServerResponse.jsonUnsafe({ message: "Event deleted from DLQ", eventId });
          }),
        ),
      )
      .handleRaw("resetAchievements", () =>
        admin(
          Effect.gen(function* () {
            const request = yield* HttpServerRequest.HttpServerRequest;
            const user = new URL(request.originalUrl).searchParams.get("user");
            if (user !== null && user.trim().length === 0)
              return yield* Effect.fail(
                new HttpBoundaryError({
                  status: 400,
                  error: "Viewer display name must not be empty",
                }),
              );
            const value = yield* achievements
              .resetOneTimeAchievements({ userDisplayName: Option.fromNullishOr(user) })
              .pipe(Effect.mapError(failure("Failed to reset achievements")));
            if (user !== null && value.deleted === 0)
              return HttpServerResponse.jsonUnsafe(
                { error: "User not found or no one-time achievements to reset", user },
                { status: 404 },
              );
            return HttpServerResponse.jsonUnsafe({
              message: "One-time achievements reset",
              deleted: value.deleted,
              achievementIds: value.achievementIds,
              user: user ?? "all",
            });
          }),
        ),
      )
      .handleRaw("achievementCounts", () =>
        admin(
          achievements.getDebugTableCounts().pipe(
            Effect.mapError(failure("Failed to fetch achievements debug counts")),
            Effect.flatMap((value) => encodeHttpResponse(AchievementDebugTableCounts, value)),
          ),
        ),
      )
      .handleRaw("achievementSnapshot", ({ params }) =>
        admin(
          achievements.getDebugUserSnapshot({ userDisplayName: params.user }).pipe(
            Effect.mapError(failure("Failed to fetch user debug snapshot")),
            Effect.flatMap((value) => encodeHttpResponse(AchievementDebugUserSnapshot, value)),
          ),
        ),
      )
      .handleRaw("commands", () =>
        admin(
          commands.getAllCommands().pipe(
            Effect.mapError(failure("Failed to list commands")),
            Effect.flatMap((value) =>
              encodeHttpResponse(Schema.Array(ChatCommandDefinition), value),
            ),
          ),
        ),
      )
      .handleRaw("createCommand", () =>
        admin(
          Effect.gen(function* () {
            const payload = yield* readCommandJson;
            const input = yield* parseCreateCommand(payload).pipe(
              Effect.mapError(
                (error) =>
                  new HttpBoundaryError({
                    status: 400,
                    error: "Invalid command payload",
                    details: formatHttpCommandIssues(error, payload),
                  }),
              ),
            );
            const value = yield* commands
              .createCommand(input)
              .pipe(Effect.mapError(commandFailure("create")));
            return yield* encodeHttpResponse(ChatCommandDefinition, value, 201);
          }),
        ),
      )
      .handleRaw("updateCommand", ({ params }) =>
        admin(
          Effect.gen(function* () {
            const payload = yield* readCommandJson;
            const patch = yield* parseUpdateCommand(payload).pipe(
              Effect.mapError(
                (error) =>
                  new HttpBoundaryError({
                    status: 400,
                    error: "Invalid command patch",
                    details: formatHttpCommandIssues(error, payload),
                  }),
              ),
            );
            const name = yield* parseChatCommandName(params.name).pipe(
              Effect.mapError(
                () =>
                  new HttpBoundaryError({
                    status: 400,
                    error: "Invalid command name",
                    code: "InvalidCommandNameError",
                  }),
              ),
            );
            const value = yield* commands
              .updateCommand({ name, patch })
              .pipe(Effect.mapError(commandFailure("update")));
            return yield* encodeHttpResponse(ChatCommandDefinition, value);
          }),
        ),
      )
      .handleRaw("deleteCommand", ({ params }) =>
        admin(
          Effect.gen(function* () {
            const name = yield* parseChatCommandName(params.name).pipe(
              Effect.mapError(
                () =>
                  new HttpBoundaryError({
                    status: 400,
                    error: "Invalid command name",
                    code: "InvalidCommandNameError",
                  }),
              ),
            );
            yield* commands.deleteCommand({ name }).pipe(Effect.mapError(commandFailure("delete")));
            return HttpServerResponse.jsonUnsafe({
              message: "Command deleted",
              command: params.name,
            });
          }),
        ),
      )
      .handleRaw("commandsSnapshot", () =>
        admin(
          Effect.gen(function* () {
            const value = yield* commands
              .getDebugSnapshot()
              .pipe(Effect.mapError(failure("Failed to fetch commands debug snapshot")));
            const encoded = yield* Schema.encodeEffect(ChatCommandDebugSnapshot)(value).pipe(
              Effect.mapError(failure("Failed to fetch commands debug snapshot")),
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
          readViewerStatsDebug(params.user).pipe(
            Effect.provideService(Achievements, achievements),
            Effect.provideService(SongQueue, songQueue),
            Effect.provideService(Raffle, raffle),
          ),
        ),
      );
  }),
);
