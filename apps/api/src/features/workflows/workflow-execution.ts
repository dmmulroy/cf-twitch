import { Cause, Clock, Context, Effect, Layer, Option, Schema, Semaphore } from "effect";
import { Digest } from "effect/crypto";
import { Hex } from "effect/encoding";
import { EventId, RedemptionId, SpotifyTrackId } from "@cf-twitch/contracts/identity";
import { DomainEvent, RaffleRollEvent } from "@cf-twitch/contracts/domain-event";
import { RaffleRecordResult } from "@cf-twitch/contracts/raffle";
import { ChatMessageText, ProviderError } from "@cf-twitch/contracts/provider";
import { SpotifyTrack, parseSpotifyTrackInput } from "@cf-twitch/contracts/spotify-track";
import {
  WorkflowError,
  WorkflowId,
  WorkflowInput,
  WorkflowRunStatus,
  workflowIdOfInput,
} from "@cf-twitch/contracts/workflow";
import { TwitchAnalytics } from "../../runtime/twitch-analytics.ts";
import { EventPublisher } from "../events/event-publisher.ts";
import { Raffle } from "../raffle/raffle-service.ts";
import { SongQueue } from "../song-queue/song-queue.ts";
import { SpotifyService } from "../providers/spotify-service.ts";
import { TwitchService } from "../providers/twitch-service.ts";
import {
  WorkflowJournal,
  workflowJournalLayer,
  workflowJournalTestLayer,
} from "./workflow-journal.ts";
import {
  workflowStepInvalidTrackMessagePrefix,
  WorkflowStepFailure,
  type WorkflowStepFailureReason,
  type WorkflowStepOperation,
  type WorkflowStepPolicy,
} from "./workflow-step.ts";
import { eventPublisherTestLayer } from "../events/event-publisher.ts";
import { raffleTestLayer } from "../raffle/raffle-service.ts";
import { songQueueTestLayer } from "../song-queue/song-queue.ts";
import { spotifyServiceTestLayer } from "../providers/spotify-service.ts";
import { twitchServiceTestLayer } from "../providers/twitch-service.ts";
import { twitchAnalyticsTestLayer } from "../../runtime/twitch-analytics.ts";

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

/** Returns the retry safety of a provider failure for a step with the given safety. */
const providerFailureKind = (
  error: ProviderError,
  safety: WorkflowStepPolicy["safety"],
): WorkflowStepFailure["kind"] => {
  const ambiguous =
    error.reason === "outcome-unknown" ||
    error.reason === "network" ||
    error.reason === "invalid-response";

  if (ambiguous) return safety === "non-idempotent" ? "unknown" : "retryable";

  if (
    error.reason === "rate-limited" ||
    Option.exists(error.status, (status) => status >= 500) ||
    error.reason === "persistence"
  )
    return "retryable";

  return "permanent";
};

/** Returns the classified reason of a provider failure, given its already-classified retry safety. */
const providerFailureReason = (
  operation: WorkflowStepOperation,
  error: ProviderError,
  kind: WorkflowStepFailure["kind"],
): WorkflowStepFailureReason => {
  if (operation === "get-spotify-track" && error.reason === "not-found")
    return "invalid_track_input";

  if (kind === "unknown") return "outcome_unknown";

  if (error.reason === "rate-limited") return "rate_limited";

  return kind === "retryable" ? "provider_unavailable" : "provider_rejected";
};

/**
 * Translates a provider failure into a step failure for the named external operation of a workflow.
 *
 * @returns The effect, failing with `WorkflowStepFailure` instead of `ProviderError`.
 */
const catchProviderFailure =
  (
    operation: WorkflowStepOperation,
    safety: WorkflowStepPolicy["safety"],
    workflowId: WorkflowId,
  ) =>
  <A, R>(effect: Effect.Effect<A, ProviderError, R>): Effect.Effect<A, WorkflowStepFailure, R> =>
    effect.pipe(
      Effect.catchTag("ProviderError", (error) => {
        const kind = providerFailureKind(error, safety);

        return Effect.fail(
          new WorkflowStepFailure({
            operation,
            reason: providerFailureReason(operation, error, kind),
            workflowId: Option.some(workflowId),
            kind,
            providerFailure: Option.some(error.reason),
            retryAfterMs: error.retryAfterMs,
          }),
        );
      }),
    );

/** Creates the retryable step failure for an unavailable durable dependency (song queue, raffle, or event bus). */
const dependencyUnavailable = (
  operation: WorkflowStepOperation,
  workflowId: WorkflowId,
): WorkflowStepFailure =>
  new WorkflowStepFailure({
    operation,
    reason: "dependency_unavailable",
    workflowId: Option.some(workflowId),
    kind: "retryable",
    providerFailure: Option.none(),
    retryAfterMs: Option.none(),
  });

/** Durable start, recovery, and diagnostics for the Song Request, Keyboard Raffle, and raid shoutout workflows. */
export interface IWorkflowExecution {
  /**
   * Persists the canonical input and runs the workflow until it completes, halts, or waits for a retry.
   *
   * **Details**
   *
   * Starting the same input again resumes the existing run; step halts are recorded as run status rather than returned.
   *
   * @returns Nothing, or fails with `WorkflowError` reason `conflict` when the input differs from the existing run, and `storage`/`corrupt`/`legacy_state`/`schedule` for journal failures.
   */
  readonly start: (input: WorkflowInput) => Effect.Effect<void, WorkflowError>;
  /**
   * Continues an unfinished run from its checkpoints; used by the Durable Object alarm.
   *
   * @returns Nothing, or fails with `WorkflowError` for journal storage, codec, legacy-format, or alarm failures.
   */
  readonly resume: () => Effect.Effect<void, WorkflowError>;
  /**
   * Returns the run's operational status, or `None` before the workflow starts.
   *
   * @returns The status, or fails with `WorkflowError` reason `storage`/`corrupt`.
   */
  readonly getStatus: () => Effect.Effect<Option.Option<WorkflowRunStatus>, WorkflowError>;
  /**
   * Re-arms the Durable Object alarm for an unfinished run when the object starts.
   *
   * @returns Nothing, or fails with `WorkflowError` reason `legacy_state`, `storage`, `corrupt`, or `schedule`.
   */
  readonly restoreAlarm: () => Effect.Effect<void, WorkflowError>;
}

/** Service tag for workflow execution, acquired once per Durable Object rather than per HTTP request. */
export class WorkflowExecution extends Context.Service<WorkflowExecution, IWorkflowExecution>()(
  "@cf-twitch/WorkflowExecution",
) {}

/** Effect that builds the three persisted workflows from the journal and their authoritative application capabilities. */
export const makeWorkflowExecution = Effect.gen(function* () {
  const journal = yield* WorkflowJournal;
  const spotify = yield* SpotifyService;
  const twitch = yield* TwitchService;
  const queue = yield* SongQueue;
  const raffle = yield* Raffle;
  const publisher = yield* EventPublisher;
  const digestService = yield* Digest.Digest;
  const analytics = yield* TwitchAnalytics;
  const permit = yield* Semaphore.make(1);

  const eventId = Effect.fn("WorkflowExecution.eventId")(function* (id: RedemptionId) {
    const workflowId = WorkflowId.make(id);

    // Effect 4.1 Digest reports an unavailable SHA implementation as a defect, not a typed failure.
    const digest = yield* digestService
      .digest(Digest.sha256, new TextEncoder().encode(`cf-twitch:saga-event:${id}`))
      .pipe(
        Effect.catchCauseIf(
          (cause) => Cause.hasDies(cause) && !Cause.hasInterrupts(cause),
          () =>
            Effect.fail(
              new WorkflowStepFailure({
                operation: "derive-event-id",
                reason: "digest_unavailable",
                workflowId: Option.some(workflowId),
                kind: "retryable",
                providerFailure: Option.none(),
                retryAfterMs: Option.none(),
              }),
            ),
        ),
      );

    const bytes = digest.slice(0, 16);
    bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
    bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
    const hex = Hex.encode(bytes);

    return EventId.make(
      `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`,
    );
  });

  const refineChatMessage = (message: string, workflowId: WorkflowId) =>
    ChatMessageText.makeEffect(message).pipe(
      Effect.mapError(
        () =>
          new WorkflowStepFailure({
            operation: "send-chat-message",
            reason: "chat_message_too_long",
            workflowId: Option.some(workflowId),
            kind: "permanent",
            providerFailure: Option.none(),
            retryAfterMs: Option.none(),
          }),
      ),
    );

  const chat = Effect.fn("WorkflowExecution.chat")(function* (
    name: string,
    message: string,
    workflowId: WorkflowId,
  ) {
    const send = Effect.gen(function* () {
      const chatMessage = yield* refineChatMessage(message, workflowId);

      return yield* twitch
        .sendChatMessage({ message: chatMessage })
        .pipe(
          catchProviderFailure("send-chat-message", "non-idempotent", workflowId),
          Effect.as(null),
        );
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

  const publish = Effect.fn("WorkflowExecution.publish")(function* (
    event: DomainEvent,
    workflowId: WorkflowId,
  ) {
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
      publisher.publish(pending).pipe(
        Effect.catchTag("EventBusError", () =>
          Effect.fail(dependencyUnavailable("publish-domain-event", workflowId)),
        ),
        Effect.as(null),
      ),
      publishPolicy,
    );
  });

  const execute = Effect.fn("WorkflowExecution.execute")(function* (input: WorkflowInput) {
    const workflowId = workflowIdOfInput(input);

    if (WorkflowInput.guards.RaidShoutout(input)) {
      const raid = input.raid;

      const sendThanks = Effect.gen(function* () {
        const thanks = yield* refineChatMessage(
          `Thanks for the raid @${raid.raider.login}! Go check them out: https://twitch.tv/${raid.raider.login}`,
          workflowId,
        );

        return yield* twitch
          .sendChatMessage({ message: thanks })
          .pipe(
            catchProviderFailure("send-chat-message", "non-idempotent", workflowId),
            Effect.as(null),
          );
      });

      yield* journal.checkpoint("send-chat-thanks", Schema.Null, sendThanks, chatPolicy);
      yield* journal.checkpoint(
        "create-native-shoutout",
        Schema.Null,
        twitch
          .createShoutout({ toBroadcasterId: raid.raider.userId })
          .pipe(
            catchProviderFailure("create-shoutout", "non-idempotent", workflowId),
            Effect.as(null),
          ),
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
          .pipe(
            catchProviderFailure("update-redemption-status", "non-idempotent", workflowId),
            Effect.as(null),
          ),
        fulfillmentPolicy,
      );

    const stableId = yield* journal.checkpoint(
      "domain-event-id",
      EventId,
      eventId(redemption.id),
      readPolicy,
    );

    if (WorkflowInput.guards.SongRequest(input)) {
      const trackId = yield* journal.checkpoint(
        "parse-spotify-url",
        SpotifyTrackId,
        parseSpotifyTrackInput(redemption.userInput).pipe(
          Effect.mapError(
            () =>
              new WorkflowStepFailure({
                operation: "parse-spotify-track",
                reason: "invalid_track_input",
                workflowId: Option.some(workflowId),
                kind: "permanent",
                providerFailure: Option.none(),
                retryAfterMs: Option.none(),
              }),
          ),
        ),
        readPolicy,
      );

      const track = yield* journal.checkpoint(
        "get-track-info",
        SpotifyTrack,
        spotify
          .getTrack(trackId)
          .pipe(catchProviderFailure("get-spotify-track", "idempotent", workflowId)),
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
          .pipe(
            Effect.catchTag("SongQueueError", () =>
              Effect.fail(dependencyUnavailable("persist-song-request", workflowId)),
            ),
            Effect.as(redemption.id),
          ),
        { ...readPolicy, attempts: 2, timeoutMs: 10_000 },
      );
      yield* journal.checkpoint(
        "add-to-spotify-queue",
        SpotifyTrackId,
        spotify
          .addToQueue(trackId)
          .pipe(
            catchProviderFailure("add-to-spotify-queue", "non-idempotent", workflowId),
            Effect.as(trackId),
          ),
        mutationPolicy,
      );
      yield* fulfill();
      yield* chat(
        "send-chat-confirmation",
        `@${redemption.userDisplayName} added "${track.name}" by ${track.artists.join(", ")} to the queue!`,
        workflowId,
      );
      yield* publish(
        {
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
        },
        workflowId,
      );
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
        .pipe(
          Effect.catchTag("RaffleError", () =>
            Effect.fail(dependencyUnavailable("record-raffle-roll", workflowId)),
          ),
        ),
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
      workflowId,
    );
    yield* chat(
      "send-chat-message",
      roll.isWinner
        ? `@${redemption.userDisplayName} YOU WON THE KEYBOARD! 🎉 Your roll: ${roll.roll} | Winning number: ${roll.winningNumber}`
        : `@${redemption.userDisplayName} lost 😭 Winning number was ${roll.winningNumber} and they rolled ${roll.roll}. Distance: ${roll.distance}`,
      workflowId,
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
    const workflowId = workflowIdOfInput(input);

    if (WorkflowInput.guards.RaidShoutout(input)) return;
    const redemption = input.redemption;

    if (WorkflowInput.guards.SongRequest(input)) {
      // Strict reverse ordering: confirmed Spotify removal, attribution deletion, then points refund.
      yield* journal.compensate(
        "add-to-spotify-queue",
        SpotifyTrackId,
        (trackId) =>
          spotify.removeFromQueue(trackId).pipe(
            catchProviderFailure("remove-from-spotify-queue", "non-idempotent", workflowId),
            Effect.flatMap((confirmed) =>
              confirmed
                ? Effect.void
                : Effect.fail(
                    new WorkflowStepFailure({
                      operation: "remove-from-spotify-queue",
                      reason: "compensation_unconfirmed",
                      workflowId: Option.some(workflowId),
                      kind: "retryable",
                      providerFailure: Option.none(),
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
        (eventId) =>
          queue
            .deleteRequest({ eventId })
            .pipe(
              Effect.catchTag("SongQueueError", () =>
                Effect.fail(dependencyUnavailable("delete-song-request", workflowId)),
              ),
            ),
        "idempotent",
      );
    } else {
      yield* journal.compensate(
        "record-roll-undo-intent",
        RedemptionId,
        (rollId) =>
          raffle
            .deleteRollById({ rollId })
            .pipe(
              Effect.catchTag("RaffleError", () =>
                Effect.fail(dependencyUnavailable("delete-raffle-roll", workflowId)),
              ),
            ),
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
        .pipe(
          catchProviderFailure("update-redemption-status", "non-idempotent", workflowId),
          Effect.as(null),
        ),
      { ...fulfillmentPolicy, attempts: 5 },
    );

    if (WorkflowInput.guards.SongRequest(input)) {
      // The persisted run error is the only durable evidence once compensation resumes after a restart.
      const invalid = Option.exists(originalError, (error) =>
        error.startsWith(workflowStepInvalidTrackMessagePrefix),
      );

      yield* chat(
        "send-failure-message",
        invalid
          ? `@${redemption.userDisplayName} your song request was invalid and your points have been refunded. Redeem again with a valid Spotify track link.`
          : `@${redemption.userDisplayName} Spotify song requests are unavailable right now and your points have been refunded. Try your request again later.`,
        workflowId,
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
              Option.some(halt.detail),
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
            return yield* journal.transition("OUTCOME_UNKNOWN", Option.some(halt.detail));
          const latest = yield* journal.getStatus();

          if (Option.isSome(latest) && Option.isSome(latest.value.fulfilledAt))
            return yield* journal.transition("POST_COMMIT_FAILED", Option.some(halt.detail));

          if (WorkflowInput.guards.RaidShoutout(input.value))
            return yield* journal.transition("FAILED", Option.some(halt.detail));
          yield* journal.transition("COMPENSATING", Option.some(halt.detail));
          yield* recoverCompensation(input.value, Option.some(halt.detail));
        }),
      ),
    );
  });

  const resume = Effect.fn("WorkflowExecution.resume")(() => permit.withPermit(resumeUnlocked()));

  const start = Effect.fn("WorkflowExecution.start")((input: WorkflowInput) =>
    permit.withPermit(journal.initialize(input).pipe(Effect.andThen(resumeUnlocked()))),
  );

  return WorkflowExecution.of({
    start,
    resume,
    getStatus: journal.getStatus,
    restoreAlarm: journal.restoreAlarm,
  });
});

/** Layer that provides workflow execution; requires the journal, providers, durable dependency clients, digest, and analytics. */
export const workflowExecutionLayerWithoutDependencies = Layer.effect(
  WorkflowExecution,
  makeWorkflowExecution,
);

/** Production execution Layer over the Durable Object SQLite journal; requires the runtime `DurableObjectState` and the captured application capabilities. */
export const workflowExecutionLayer = workflowExecutionLayerWithoutDependencies.pipe(
  Layer.provide(workflowJournalLayer),
);

/**
 * Execution Layer over the journal with an in-memory alarm and the test Layers of every provider,
 * dependency client, and analytics; the test selects SQL and platform services.
 */
export const workflowExecutionTestLayer = workflowExecutionLayerWithoutDependencies.pipe(
  Layer.provide([
    workflowJournalTestLayer,
    eventPublisherTestLayer,
    raffleTestLayer,
    songQueueTestLayer,
    spotifyServiceTestLayer,
    twitchServiceTestLayer,
    twitchAnalyticsTestLayer,
  ]),
);
