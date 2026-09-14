import { Schema } from "effect";
import {
  BroadcasterId,
  EventSubMessageId,
  IsoTimestamp,
  NonNegativeInt,
  RedemptionId,
} from "./identity.ts";
import { ChannelPointRedemption } from "./redemption.ts";

/** Workflow identity is the redemption ID or signed EventSub message ID, never a random run ID. */
export const WorkflowId = Schema.NonEmptyString.pipe(Schema.brand("WorkflowId"));

/** Parsed durable workflow identity, distinct from a provider object handle. */
export type WorkflowId = typeof WorkflowId.Type;

/** Persisted lifecycle distinguishes unknown effects and exhausted postcommit work from failure. */
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

/** Raid identity and ordering come from the authenticated EventSub envelope. */
export const RaidShoutoutInput = Schema.Struct({
  messageId: EventSubMessageId,
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

/** Original canonical workflow parameters are authoritative on every restart. */
export const WorkflowInput = Schema.TaggedUnion({
  SongRequest: { redemption: ChannelPointRedemption },
  KeyboardRaffle: { redemption: ChannelPointRedemption },
  RaidShoutout: { raid: RaidShoutoutInput },
});

/** Canonical workflow parameters persisted before any downstream effects. */
export type WorkflowInput = typeof WorkflowInput.Type;

/** Operational workflow projection deliberately excludes personal inputs and checkpoint payloads. */
export const WorkflowRunStatus = Schema.Struct({
  sagaId: WorkflowId,
  status: WorkflowStatus,
  fulfilledAt: Schema.OptionFromNullOr(IsoTimestamp),
  error: Schema.OptionFromNullOr(Schema.String),
  createdAt: IsoTimestamp,
  updatedAt: IsoTimestamp,
});

/** Parsed workflow diagnostics with absent evidence normalized to Option. */
export interface WorkflowRunStatus extends Schema.Schema.Type<typeof WorkflowRunStatus> {}

/** Status lookup selects the same namespace and deterministic identity as workflow start. */
export const WorkflowLookup = Schema.TaggedUnion({
  SongRequest: { redemptionId: RedemptionId },
  KeyboardRaffle: { redemptionId: RedemptionId },
  RaidShoutout: { messageId: EventSubMessageId },
});

/** Namespace-qualified deterministic workflow status lookup. */
export type WorkflowLookup = typeof WorkflowLookup.Type;

/** Workflow persistence and scheduling failures are retryable intake failures, not business failure. */
export class WorkflowError extends Schema.TaggedError<WorkflowError>()("WorkflowError", {
  operation: Schema.String,
  reason: Schema.Literals([
    "storage",
    "corrupt",
    "schedule",
    "conflict",
    "transport",
    "invalid_response",
  ]),
}) {
  /** Stable workflow failure message excludes checkpoint and provider detail. */
  override get message(): string {
    return `Workflow ${this.operation} failed (${this.reason})`;
  }
}
