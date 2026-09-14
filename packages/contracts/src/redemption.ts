import { Schema } from "effect";
import {
  BroadcasterId,
  IsoTimestamp,
  NonNegativeInt,
  RedemptionId,
  RewardId,
  ViewerId,
} from "./identity.ts";

/** Reward metadata captured when a viewer spends channel points. */
export const ChannelPointReward = Schema.Struct({
  id: RewardId,
  title: Schema.NonEmptyString,
  cost: NonNegativeInt,
  prompt: Schema.String,
});

/** Parsed reward metadata; its identity is distinct from a redemption identity. */
export type ChannelPointReward = typeof ChannelPointReward.Type;

/** Canonical redemption persisted by a durable workflow without EventSub routing metadata. */
export const ChannelPointRedemption = Schema.Struct({
  id: RedemptionId,
  broadcasterId: BroadcasterId,
  userId: ViewerId,
  userLogin: Schema.NonEmptyString,
  userDisplayName: Schema.NonEmptyString,
  userInput: Schema.String,
  reward: ChannelPointReward,
  redeemedAt: IsoTimestamp,
});

/** Parsed channel point redemption accepted by song request and raffle workflows. */
export type ChannelPointRedemption = typeof ChannelPointRedemption.Type;
