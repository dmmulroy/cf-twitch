import { Match, Schema } from "effect";
import {
  BroadcasterId,
  EventSubMessageId,
  IsoTimestamp,
  NonNegativeInt,
  RedemptionId,
} from "./identity.ts";
import { ChannelPointRedemption } from "./redemption.ts";

/** Schema for durable workflow identity: the redemption ID or signed EventSub message ID, never a random run ID. */
export const WorkflowId = Schema.NonEmptyString.pipe(Schema.brand("WorkflowId"));

/** Parsed durable workflow identity, distinct from a provider object handle. */
export type WorkflowId = typeof WorkflowId.Type;

/** Schema for the persisted workflow lifecycle, which distinguishes unknown effects and exhausted post-commit work from failure. */
export const WorkflowStatus = Schema.Literals([
  "RUNNING",
  "COMPENSATING",
  "COMPLETED",
  "FAILED",
  "COMPENSATION_FAILED",
  "OUTCOME_UNKNOWN",
  "POST_COMMIT_FAILED",
]);

/** Closed durable workflow lifecycle vocabulary. */
export type WorkflowStatus = typeof WorkflowStatus.Type;

/** Schema for raid shoutout parameters, whose identity and ordering come from the authenticated EventSub envelope. */
export const RaidShoutoutInput = Schema.Struct({
  messageId: EventSubMessageId,
  /** Signed EventSub source time, used for ordering rather than server ingestion time. */
  receivedAt: IsoTimestamp,
  raider: Schema.Struct({
    userId: BroadcasterId,
    login: Schema.String,
    displayName: Schema.String,
  }),
  viewers: NonNegativeInt,
});

/** Parsed raid parameters retain signed EventSub source ordering. */
export interface RaidShoutoutInput extends Schema.Schema.Type<typeof RaidShoutoutInput> {}

/** Schema for canonical workflow parameters, authoritative on every restart. */
export const WorkflowInput = Schema.TaggedUnion({
  SongRequest: { redemption: ChannelPointRedemption },
  KeyboardRaffle: { redemption: ChannelPointRedemption },
  RaidShoutout: { raid: RaidShoutoutInput },
});

/** Canonical workflow parameters persisted before any downstream effects. */
export type WorkflowInput = typeof WorkflowInput.Type;

/** Schema for the operational workflow projection, which deliberately excludes personal inputs and checkpoint payloads. */
export const WorkflowRunStatus = Schema.Struct({
  sagaId: WorkflowId,
  status: WorkflowStatus,
  /** Point of no return: once present, the redemption is never refunded. */
  fulfilledAt: Schema.OptionFromNullOr(IsoTimestamp),
  /** Operator diagnostic for the step failure that ended or paused the run. */
  error: Schema.OptionFromNullOr(Schema.String),
  createdAt: IsoTimestamp,
  updatedAt: IsoTimestamp,
});

/** Parsed workflow diagnostics with absent evidence normalized to Option. */
export interface WorkflowRunStatus extends Schema.Schema.Type<typeof WorkflowRunStatus> {}

/** Schema for a status lookup that selects the same namespace and deterministic identity as workflow start. */
export const WorkflowLookup = Schema.TaggedUnion({
  SongRequest: { redemptionId: RedemptionId },
  KeyboardRaffle: { redemptionId: RedemptionId },
  RaidShoutout: { messageId: EventSubMessageId },
});

/** Namespace-qualified deterministic workflow status lookup. */
export type WorkflowLookup = typeof WorkflowLookup.Type;

/** Schema for the workflow operations whose failures `WorkflowError` reports. */
export const WorkflowOperation = Schema.Literals([
  "start",
  "get-status",
  "read-run",
  "legacy-state-gate",
  "require-run",
  "initialize",
  "get-input",
  "transition",
  "restore-alarm",
  "checkpoint",
  "compensate",
]);

/** Workflow operation that failed. */
export type WorkflowOperation = typeof WorkflowOperation.Type;

/** Schema for the classified causes of a `WorkflowError`. */
export const WorkflowFailureReason = Schema.Literals([
  "storage",
  "corrupt",
  "legacy_state",
  "missing_run",
  "schedule",
  "conflict",
  "already_fulfilled",
  "transport",
  "invalid_response",
]);

/** Classified cause of a workflow failure. */
export type WorkflowFailureReason = typeof WorkflowFailureReason.Type;

/** Error raised when workflow persistence, scheduling, or transport fails; these are retryable intake failures, not business failure. */
export class WorkflowError extends Schema.TaggedError<WorkflowError>()("WorkflowError", {
  operation: WorkflowOperation,
  reason: WorkflowFailureReason,
  /** Workflow whose operation failed, when the failing code knows it. */
  workflowId: Schema.OptionFromNullOr(WorkflowId),
  /** Checkpoint step being executed or compensated, for `checkpoint` and `compensate` operations. */
  stepName: Schema.OptionFromNullOr(Schema.String),
}) {
  /** Workflow failure message naming the operation and classified reason, excluding checkpoint and provider detail. */
  override get message(): string {
    return Match.value(this.reason).pipe(
      Match.when(
        "storage",
        () =>
          `Workflow journal storage failed during ${this.operation}. Retry the operation; checkpoints make a repeated start or resume safe.`,
      ),
      Match.when(
        "corrupt",
        () =>
          `Workflow journal data is unreadable during ${this.operation}. Inspect the workflow's stored run and steps before retrying.`,
      ),
      Match.when(
        "legacy_state",
        () =>
          `Workflow run predates the current journal format during ${this.operation}. Drain or translate the legacy run before resuming it.`,
      ),
      Match.when(
        "missing_run",
        () =>
          `Workflow run was not found during ${this.operation}. Start the workflow with its original input before resuming it.`,
      ),
      Match.when(
        "schedule",
        () =>
          `Workflow alarm could not be scheduled during ${this.operation}. Retry the operation to schedule the workflow again.`,
      ),
      Match.when(
        "conflict",
        () =>
          `Workflow input conflicts with the existing run during ${this.operation}. Inspect the existing workflow status; a changed input is never applied to an existing run.`,
      ),
      Match.when(
        "already_fulfilled",
        () =>
          `Workflow compensation was refused because the redemption is already fulfilled. Inspect the workflow status; fulfilled redemptions are never refunded.`,
      ),
      Match.when(
        "transport",
        () =>
          `Workflow service was unreachable during ${this.operation}. Retry the request; starting the same workflow again resumes the existing run.`,
      ),
      Match.when(
        "invalid_response",
        () =>
          `Workflow service returned an unreadable response during ${this.operation}. Retry the request; starting the same workflow again resumes the existing run.`,
      ),
      Match.exhaustive,
    );
  }
}
