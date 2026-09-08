import { Clock, Context, Crypto, Effect, Layer, Option, Schema, Semaphore } from "effect";
import { EventId, RedemptionId, SpotifyTrackId } from "@cf-twitch/contracts/identity";
import { DomainEvent, RaffleRollEvent } from "@cf-twitch/contracts/domain-event";
import { RaffleRecordResult } from "@cf-twitch/contracts/raffle";
import { ChatMessageText, ProviderError } from "@cf-twitch/contracts/provider";
import { SpotifyTrack, parseSpotifyTrackInput } from "@cf-twitch/contracts/spotify-track";
import { WorkflowError, WorkflowInput, WorkflowRunStatus } from "@cf-twitch/contracts/workflow";
import { TwitchAnalytics } from "../../runtime/twitch-analytics.ts";
import { EventPublisher } from "../events/event-publisher.ts";
import { Raffle } from "../raffle/raffle-service.ts";
import { SongQueue } from "../song-queue/song-queue.ts";
import { SpotifyService } from "../providers/spotify-service.ts";
import { TwitchService } from "../providers/twitch-service.ts";
import {
  WorkflowJournal,
  WorkflowStepFailure,
  type WorkflowStepPolicy,
} from "./workflow-journal.ts";

const readPolicy: WorkflowStepPolicy = {
  attempts: 3,
  timeoutMs: 30_000,
  safety: "idempotent",
  rollback: false,
};
const undoablePolicy: WorkflowStepPolicy = {
  attempts: 2,
  timeoutMs: 10_000,
  safety: "idempotent",
  rollback: true,
};
const mutationPolicy: WorkflowStepPolicy = {
  attempts: 3,
  timeoutMs: 30_000,
  safety: "non-idempotent",
  rollback: true,
};
const fulfillmentPolicy: WorkflowStepPolicy = {
  attempts: 3,
  timeoutMs: 30_000,
  safety: "non-idempotent",
  rollback: false,
};
const chatPolicy: WorkflowStepPolicy = {
  attempts: 2,
  timeoutMs: 10_000,
  safety: "non-idempotent",
  rollback: false,
};
const publishPolicy: WorkflowStepPolicy = {
  attempts: 5,
  timeoutMs: 10_000,
  safety: "idempotent",
  rollback: false,
};
const providerFailure =
  (safety: WorkflowStepPolicy["safety"]) =>
  (error: ProviderError): WorkflowStepFailure =>
    new WorkflowStepFailure({
      kind:
        error.kind === "outcome-unknown" ||
        error.kind === "network" ||
        error.kind === "invalid-response"
          ? safety === "non-idempotent"
            ? "unknown"
            : "retryable"
          : error.kind === "rate-limited" || error.status >= 500 || error.kind === "persistence"
            ? "retryable"
            : "permanent",
      message:
        error.kind === "not-found" && error.operation === "getTrack"
          ? "Workflow Spotify track input is invalid"
          : error.message,
      retryAfterMs: error.retryAfterMs,
    });
const durableFailure = (error: { readonly message: string }): WorkflowStepFailure =>
  new WorkflowStepFailure({
    kind: "retryable",
    message: error.message,
    retryAfterMs: Option.none(),
  });

/** Workflow executor exposes durable start, recovery and diagnostics through the same service seam. */
export interface IWorkflowExecution {
  readonly start: (input: WorkflowInput) => Effect.Effect<void, WorkflowError>;
  readonly resume: () => Effect.Effect<void, WorkflowError>;
  readonly getStatus: () => Effect.Effect<Option.Option<WorkflowRunStatus>, WorkflowError>;
}
/** One workflow execution service is acquired per Durable Object, never per HTTP request. */
export class WorkflowExecution extends Context.Service<WorkflowExecution, IWorkflowExecution>()(
  "@cf-twitch/WorkflowExecution",
) {}
/** Construct all three persisted workflows from their authoritative application capabilities. */
export const makeWorkflowExecution = Effect.gen(function* () {
  const journal = yield* WorkflowJournal;
  const spotify = yield* SpotifyService;
  const twitch = yield* TwitchService;
  const queue = yield* SongQueue;
  const raffle = yield* Raffle;
  const publisher = yield* EventPublisher;
  const crypto = yield* Crypto.Crypto;
  const analytics = yield* TwitchAnalytics;
  const permit = yield* Semaphore.make(1);
  const eventId = Effect.fn("WorkflowExecution.eventId")(function* (id: RedemptionId) {
    const digest = yield* crypto
      .digest("SHA-256", new TextEncoder().encode(`cf-twitch:saga-event:${id}`))
      .pipe(
        Effect.mapError(() => durableFailure({ message: "Workflow event identity digest failed" })),
      );
    const bytes = digest.slice(0, 16);
    bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
    bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
    const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
    return EventId.make(
      `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`,
    );
  });
  const refineChatMessage = (message: string) =>
    ChatMessageText.makeEffect(message).pipe(
      Effect.mapError(
        () =>
          new WorkflowStepFailure({
            kind: "permanent",
            message: "Workflow chat message exceeds Twitch delivery constraints",
            retryAfterMs: Option.none(),
          }),
      ),
    );
  const chat = Effect.fn("WorkflowExecution.chat")(function* (name: string, message: string) {
    const send = Effect.gen(function* () {
      const chatMessage = yield* refineChatMessage(message);
      return yield* twitch
        .sendChatMessage({ message: chatMessage })
        .pipe(Effect.mapError(providerFailure("non-idempotent")), Effect.as(null));
    });
    yield* journal.checkpoint(name, Schema.Null, send, chatPolicy).pipe(
      // Optional chat is never resent after ambiguous delivery; required domain publication still proceeds.
      Effect.catchTag("WorkflowStepHalt", (error) =>
        error.reason === "retry" ? Effect.fail(error) : Effect.void,
      ),
    );
  });
  const metric = Effect.fn("WorkflowExecution.metric")(
    (name: string, operation: Effect.Effect<void>) =>
      journal
        .checkpoint(name, Schema.Null, operation.pipe(Effect.as(null)), {
          attempts: 1,
          timeoutMs: 10_000,
          safety: "non-idempotent",
          rollback: false,
        })
        .pipe(Effect.catchTag("WorkflowStepHalt", () => Effect.void)),
  );
  const publish = Effect.fn("WorkflowExecution.publish")(function* (event: DomainEvent) {
    // Persist the complete event before the publication boundary. Its ID and source timestamp never change on retry.
    const pending = yield* journal.checkpoint(
      "domain-event-intent",
      DomainEvent,
      Effect.succeed(event),
      readPolicy,
    );
    yield* journal.checkpoint(
      "publish-event",
      Schema.Null,
      publisher.publish(pending).pipe(Effect.mapError(durableFailure), Effect.as(null)),
      publishPolicy,
    );
  });
  const execute = Effect.fn("WorkflowExecution.execute")(function* (input: WorkflowInput) {
    if (input._tag === "RaidShoutout") {
      const raid = input.raid;
      const sendThanks = Effect.gen(function* () {
        const thanks = yield* refineChatMessage(
          `Thanks for the raid @${raid.raider.login}! Go check them out: https://twitch.tv/${raid.raider.login}`,
        );
        return yield* twitch
          .sendChatMessage({ message: thanks })
          .pipe(Effect.mapError(providerFailure("non-idempotent")), Effect.as(null));
      });
      yield* journal.checkpoint("send-chat-thanks", Schema.Null, sendThanks, chatPolicy);
      yield* journal.checkpoint(
        "create-native-shoutout",
        Schema.Null,
        twitch
          .createShoutout({ toBroadcasterId: raid.raider.userId })
          .pipe(Effect.mapError(providerFailure("non-idempotent")), Effect.as(null)),
        chatPolicy,
      );
      return;
    }
    const redemption = input.redemption;
    const fulfill = () =>
      journal.checkpoint(
        "fulfill-redemption",
        Schema.Null,
        twitch
          .updateRedemptionStatus({
            rewardId: redemption.reward.id,
            redemptionId: redemption.id,
            status: "FULFILLED",
          })
          .pipe(Effect.mapError(providerFailure("non-idempotent")), Effect.as(null)),
        fulfillmentPolicy,
      );
    const stableId = yield* journal.checkpoint(
      "domain-event-id",
      EventId,
      eventId(redemption.id),
      readPolicy,
    );
    if (input._tag === "SongRequest") {
      const trackId = yield* journal.checkpoint(
        "parse-spotify-url",
        SpotifyTrackId,
        parseSpotifyTrackInput(redemption.userInput).pipe(
          Effect.mapError(
            () =>
              new WorkflowStepFailure({
                kind: "permanent",
                message: "Workflow Spotify track input is invalid",
                retryAfterMs: Option.none(),
              }),
          ),
        ),
        readPolicy,
      );
      const track = yield* journal.checkpoint(
        "get-track-info",
        SpotifyTrack,
        spotify.getTrack(trackId).pipe(Effect.mapError(providerFailure("idempotent"))),
        readPolicy,
      );
      // Known-key undo intent survives remote commit followed by lost HTTP response, even if every retry fails.
      yield* journal.checkpoint(
        "persist-request-undo-intent",
        RedemptionId,
        Effect.succeed(redemption.id),
        undoablePolicy,
      );
      yield* journal.checkpoint(
        "persist-request",
        RedemptionId,
        queue
          .persistRequest({
            eventId: redemption.id,
            track,
            requesterUserId: redemption.userId,
            requesterDisplayName: redemption.userDisplayName,
            requestedAt: redemption.redeemedAt,
          })
          .pipe(Effect.mapError(durableFailure), Effect.as(redemption.id)),
        { ...readPolicy, attempts: 2, timeoutMs: 10_000 },
      );
      yield* journal.checkpoint(
        "add-to-spotify-queue",
        SpotifyTrackId,
        spotify
          .addToQueue(trackId)
          .pipe(Effect.mapError(providerFailure("non-idempotent")), Effect.as(trackId)),
        mutationPolicy,
      );
      yield* fulfill();
      yield* chat(
        "send-chat-confirmation",
        `@${redemption.userDisplayName} added "${track.name}" by ${track.artists.join(", ")} to the queue!`,
      );
      yield* publish({
        id: stableId,
        v: 1,
        type: "song_request_success",
        source: "SongRequestSagaDO",
        timestamp: redemption.redeemedAt,
        correlationId: Option.some(redemption.id),
        userId: redemption.userId,
        userDisplayName: redemption.userDisplayName,
        sagaId: redemption.id,
        trackId,
      });
      yield* metric(
        "song-request-metric",
        analytics.writeSongRequestMetric({
          requester: redemption.userDisplayName,
          trackId,
          trackName: track.name,
          status: "fulfilled",
          latencyMs: Math.max(
            0,
            (yield* Clock.currentTimeMillis) - Date.parse(redemption.redeemedAt),
          ),
        }),
      );
      return;
    }
    yield* journal.checkpoint(
      "record-roll-undo-intent",
      RedemptionId,
      Effect.succeed(redemption.id),
      undoablePolicy,
    );
    const recorded = yield* journal.checkpoint(
      "record-roll",
      RaffleRecordResult,
      raffle
        .getOrCreateRoll({
          id: redemption.id,
          userId: redemption.userId,
          displayName: redemption.userDisplayName,
          rolledAt: redemption.redeemedAt,
        })
        .pipe(Effect.mapError(durableFailure)),
      { ...readPolicy, attempts: 2, timeoutMs: 10_000 },
    );
    const roll = recorded.roll;
    yield* fulfill();
    yield* publish(
      RaffleRollEvent.make({
        id: stableId,
        v: 1,
        type: "raffle_roll",
        source: "KeyboardRaffleSagaDO",
        timestamp: redemption.redeemedAt,
        correlationId: Option.some(redemption.id),
        userId: redemption.userId,
        userDisplayName: redemption.userDisplayName,
        sagaId: redemption.id,
        roll: roll.roll,
        winningNumber: roll.winningNumber,
        distance: roll.distance,
        isWinner: roll.isWinner,
        isNewRecord: roll.isNewRecord,
      }),
    );
    yield* chat(
      "send-chat-message",
      roll.isWinner
        ? `@${redemption.userDisplayName} YOU WON THE KEYBOARD! 🎉 Your roll: ${roll.roll} | Winning number: ${roll.winningNumber}`
        : `@${redemption.userDisplayName} lost 😭 Winning number was ${roll.winningNumber} and they rolled ${roll.roll}. Distance: ${roll.distance}`,
    );
    yield* metric(
      "raffle-roll-metric",
      analytics.writeRaffleRollMetric({
        user: redemption.userDisplayName,
        roll: roll.roll,
        winningNumber: roll.winningNumber,
        distance: roll.distance,
        status: roll.isWinner ? "win" : "loss",
      }),
    );
  });
  const compensate = Effect.fn("WorkflowExecution.compensate")(function* (
    input: WorkflowInput,
    originalError: Option.Option<string>,
  ) {
    if (input._tag === "RaidShoutout") return;
    const redemption = input.redemption;
    if (input._tag === "SongRequest") {
      // Strict reverse ordering: confirmed Spotify removal, attribution deletion, then points refund.
      yield* journal.compensate(
        "add-to-spotify-queue",
        SpotifyTrackId,
        (trackId) =>
          spotify.removeFromQueue(trackId).pipe(
            Effect.mapError(providerFailure("non-idempotent")),
            Effect.flatMap((confirmed) =>
              confirmed
                ? Effect.void
                : Effect.fail(
                    new WorkflowStepFailure({
                      kind: "retryable",
                      message: "Workflow Spotify compensation was not confirmed; refund withheld",
                      retryAfterMs: Option.none(),
                    }),
                  ),
            ),
          ),
        "non-idempotent",
      );
      yield* journal.compensate(
        "persist-request-undo-intent",
        RedemptionId,
        (eventId) => queue.deleteRequest({ eventId }).pipe(Effect.mapError(durableFailure)),
        "idempotent",
      );
    } else {
      yield* journal.compensate(
        "record-roll-undo-intent",
        RedemptionId,
        (rollId) => raffle.deleteRollById({ rollId }).pipe(Effect.mapError(durableFailure)),
        "idempotent",
      );
    }
    yield* journal.checkpoint(
      "refund-redemption",
      Schema.Null,
      twitch
        .updateRedemptionStatus({
          rewardId: redemption.reward.id,
          redemptionId: redemption.id,
          status: "CANCELED",
        })
        .pipe(Effect.mapError(providerFailure("non-idempotent")), Effect.as(null)),
      { ...fulfillmentPolicy, attempts: 5 },
    );
    if (input._tag === "SongRequest") {
      const invalid = Option.getOrNull(originalError) === "Workflow Spotify track input is invalid";
      yield* chat(
        "send-failure-message",
        invalid
          ? `@${redemption.userDisplayName} your song request was invalid and your points have been refunded. Did you use a valid Spotify track link?`
          : `@${redemption.userDisplayName} Spotify song requests are unavailable right now and your points have been refunded.`,
      );
    }
  });
  const recoverCompensation = Effect.fn("WorkflowExecution.recoverCompensation")(function* (
    input: WorkflowInput,
    error: Option.Option<string>,
  ) {
    yield* compensate(input, error).pipe(
      Effect.andThen(journal.transition("FAILED", error)),
      Effect.catchTag("WorkflowStepHalt", (halt) =>
        halt.reason === "retry"
          ? Effect.void
          : journal.transition(
              halt.reason === "unknown" ? "OUTCOME_UNKNOWN" : "COMPENSATION_FAILED",
              Option.some(halt.message),
            ),
      ),
    );
  });
  const resumeUnlocked = Effect.fn("WorkflowExecution.resumeUnlocked")(function* () {
    const status = yield* journal.getStatus();
    if (
      Option.isNone(status) ||
      (status.value.status !== "RUNNING" && status.value.status !== "COMPENSATING")
    )
      return yield* journal.restoreAlarm();
    const input = yield* journal.getInput();
    if (Option.isNone(input)) return;
    if (status.value.status === "COMPENSATING")
      return yield* recoverCompensation(input.value, status.value.error);
    yield* execute(input.value).pipe(
      Effect.andThen(journal.transition("COMPLETED", Option.none())),
      Effect.catchTag("WorkflowStepHalt", (halt) =>
        Effect.gen(function* () {
          if (halt.reason === "retry") return;
          if (halt.reason === "unknown")
            return yield* journal.transition("OUTCOME_UNKNOWN", Option.some(halt.message));
          const latest = yield* journal.getStatus();
          if (Option.isSome(latest) && Option.isSome(latest.value.fulfilledAt))
            return yield* journal.transition("POST_COMMIT_FAILED", Option.some(halt.message));
          if (input.value._tag === "RaidShoutout")
            return yield* journal.transition("FAILED", Option.some(halt.message));
          yield* journal.transition("COMPENSATING", Option.some(halt.message));
          yield* recoverCompensation(input.value, Option.some(halt.message));
        }),
      ),
    );
  });
  const resume = Effect.fn("WorkflowExecution.resume")(() =>
    permit.withPermits(1)(resumeUnlocked()),
  );
  const start = Effect.fn("WorkflowExecution.start")((input: WorkflowInput) =>
    permit.withPermits(1)(journal.initialize(input).pipe(Effect.andThen(resumeUnlocked()))),
  );
  return WorkflowExecution.of({ start, resume, getStatus: journal.getStatus });
});
/** Workflow execution retains real dependency requirements for runtime and controlled-provider tests. */
export const workflowExecutionLayerWithoutDependencies = Layer.effect(
  WorkflowExecution,
  makeWorkflowExecution,
);
