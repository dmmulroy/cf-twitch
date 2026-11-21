import { Match, Option, Schema } from "effect";
import { ProviderFailureReason } from "@cf-twitch/contracts/provider";
import { WorkflowId } from "@cf-twitch/contracts/workflow";

/** Schema for the external operations a workflow checkpoint can perform. */
export const WorkflowStepOperation = Schema.Literals([
  "run-step",
  "parse-spotify-track",
  "get-spotify-track",
  "add-to-spotify-queue",
  "remove-from-spotify-queue",
  "persist-song-request",
  "delete-song-request",
  "record-raffle-roll",
  "delete-raffle-roll",
  "send-chat-message",
  "create-shoutout",
  "update-redemption-status",
  "publish-domain-event",
  "derive-event-id",
]);

/** External operation a workflow checkpoint performs. */
export type WorkflowStepOperation = typeof WorkflowStepOperation.Type;

/** Schema for the classified causes of a `WorkflowStepFailure`. */
export const WorkflowStepFailureReason = Schema.Literals([
  "timed_out",
  "outcome_unknown",
  "rate_limited",
  "provider_unavailable",
  "provider_rejected",
  "invalid_track_input",
  "dependency_unavailable",
  "compensation_unconfirmed",
  "chat_message_too_long",
  "digest_unavailable",
]);

/** Classified cause of a workflow step failure. */
export type WorkflowStepFailureReason = typeof WorkflowStepFailureReason.Type;

/**
 * Persisted run-error text for invalid Spotify track input.
 *
 * **Gotchas**
 *
 * Compensation selects the viewer's refund message by matching this prefix in the persisted run error, so changing it changes the chat message for runs already compensating.
 */
export const workflowStepInvalidTrackMessagePrefix = "Workflow Spotify track input is invalid";

/** Error raised by one checkpoint operation, classified by whether another attempt is safe. */
export class WorkflowStepFailure extends Schema.TaggedError<WorkflowStepFailure>()(
  "WorkflowStepFailure",
  {
    /** External operation the step performed. */
    operation: WorkflowStepOperation,
    /** Classified cause; selects the operator message. */
    reason: WorkflowStepFailureReason,
    /** Workflow whose step failed, when the failing code knows it. */
    workflowId: Schema.OptionFromNullOr(WorkflowId),
    /** Retry safety: `retryable` may repeat, `permanent` will fail again, `unknown` may already have taken effect. */
    kind: Schema.Literals(["retryable", "permanent", "unknown"]),
    /** Provider classification behind the failure, when a provider reported one. */
    providerFailure: Schema.OptionFromNullOr(ProviderFailureReason),
    /** Provider-requested delay before another attempt, in milliseconds. */
    retryAfterMs: Schema.OptionFromNullOr(Schema.Number),
  },
) {
  /** Step failure message naming the operation and classified reason; persisted as the step's and run's operator diagnostic. */
  override get message(): string {
    const provider = Option.match(this.providerFailure, {
      onNone: () => "",
      onSome: (kind) => ` (provider reported ${kind})`,
    });

    return Match.value(this.reason).pipe(
      Match.when(
        "timed_out",
        () =>
          `Workflow step ${this.operation} timed out. Inspect the workflow status; idempotent steps retry automatically and others are marked outcome unknown.`,
      ),
      Match.when(
        "outcome_unknown",
        () =>
          `Workflow step ${this.operation} ended with an unknown outcome${provider}. Reconcile the external effect before retrying; it is not retried automatically.`,
      ),
      Match.when(
        "rate_limited",
        () =>
          `Workflow step ${this.operation} was rate limited${provider}. Wait for the workflow alarm; the journal retries after the provider's delay while attempts remain.`,
      ),
      Match.when(
        "provider_unavailable",
        () =>
          `Workflow step ${this.operation} failed because the provider was unavailable${provider}. Wait for the workflow alarm; the journal retries while attempts remain.`,
      ),
      Match.when(
        "provider_rejected",
        () =>
          `Workflow step ${this.operation} was rejected by the provider${provider}. Check the provider connection and configuration before the next redemption.`,
      ),
      Match.when(
        "invalid_track_input",
        () =>
          `${workflowStepInvalidTrackMessagePrefix}. Ask the viewer to redeem again with a Spotify track link.`,
      ),
      Match.when(
        "dependency_unavailable",
        () =>
          `Workflow step ${this.operation} failed because a durable dependency was unavailable. Wait for the workflow alarm; the journal retries while attempts remain.`,
      ),
      Match.when(
        "compensation_unconfirmed",
        () =>
          `Workflow Spotify compensation was not confirmed during ${this.operation}, so the refund was withheld. Inspect the Spotify queue and remove the track before refunding.`,
      ),
      Match.when(
        "chat_message_too_long",
        () =>
          `Workflow chat message exceeds Twitch delivery constraints during ${this.operation}, so it was not sent. Shorten the chat message template.`,
      ),
      Match.when(
        "digest_unavailable",
        () =>
          `Workflow event identity digest failed during ${this.operation} because SHA-256 was unavailable. Wait for the workflow alarm; the identity is derived deterministically on retry.`,
      ),
      Match.exhaustive,
    );
  }
}

/** Error that halts a workflow at a checkpoint; durable control flow, never a persistence failure, and never a refund trigger by itself. */
export class WorkflowStepHalt extends Schema.TaggedError<WorkflowStepHalt>()("WorkflowStepHalt", {
  /** Journal operation that halted; always a checkpoint, including compensation checkpoints. */
  operation: Schema.Literal("checkpoint"),
  /** Workflow whose checkpoint halted. */
  workflowId: WorkflowId,
  /** Checkpoint step that halted. */
  stepName: Schema.String,
  /** `retry` waits for the alarm, `failed` exhausted or refused the step, `unknown` may already have taken effect. */
  reason: Schema.Literals(["retry", "failed", "unknown"]),
  /** Operator diagnostic persisted as the run error when the halt ends or pauses the run. */
  detail: Schema.String,
}) {
  /** Halt message naming the step and halt reason, followed by its diagnostic and way forward. */
  override get message(): string {
    return `Workflow step ${this.stepName} halted with reason ${this.reason}. ${this.detail}`;
  }
}

/** Checkpoint policy declaring the attempt budget and whether interruption permits replay. */
export interface WorkflowStepPolicy {
  /** Total attempts, including the first, before the step fails permanently. */
  readonly attempts: number;
  /** Per-attempt deadline in milliseconds; a timeout counts as a failed attempt. */
  readonly timeoutMs: number;
  /** `non-idempotent` steps interrupted after dispatch become outcome unknown instead of being replayed. */
  readonly safety: "idempotent" | "non-idempotent";
  /** Whether the step's result is also stored as undo evidence for compensation. */
  readonly rollback: boolean;
}
