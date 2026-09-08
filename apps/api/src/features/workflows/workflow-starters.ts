import { Context, Effect, Option } from "effect";
import type { ChannelPointRedemption } from "@cf-twitch/contracts/redemption";
import type {
  RaidShoutoutInput,
  WorkflowError,
  WorkflowLookup,
  WorkflowRunStatus,
} from "@cf-twitch/contracts/workflow";

/** Workflow start persists canonical input and safely resumes by deterministic identity. */
export interface IWorkflowStarters {
  readonly startSongRequest: (
    redemption: ChannelPointRedemption,
  ) => Effect.Effect<void, WorkflowError>;
  readonly startKeyboardRaffle: (
    redemption: ChannelPointRedemption,
  ) => Effect.Effect<void, WorkflowError>;
  readonly startRaidShoutout: (raid: RaidShoutoutInput) => Effect.Effect<void, WorkflowError>;
  readonly getStatus: (
    input: WorkflowLookup,
  ) => Effect.Effect<Option.Option<WorkflowRunStatus>, WorkflowError>;
}
/** Workflow clients own namespace selection and never expose invocation-scoped DO stubs. */
export class WorkflowStarters extends Context.Service<WorkflowStarters, IWorkflowStarters>()(
  "@cf-twitch/WorkflowStarters",
) {}
