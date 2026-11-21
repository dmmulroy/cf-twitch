import { Schema } from "effect";
import {
  BroadcasterId,
  IsoTimestamp,
  NonNegativeInt,
  RedemptionId,
  RewardId,
  ViewerId,
} from "./identity.ts";

/** Schema for the reward metadata captured when a Viewer spends channel points. */
export const ChannelPointReward = Schema.Struct({
  id: RewardId,
  title: Schema.NonEmptyString,
  /** Channel points spent on the redemption. */
  cost: NonNegativeInt,
  /** Instructions Twitch showed the Viewer when redeeming the reward. */
  prompt: Schema.String,
});

/** Reward metadata of a Channel Point Redemption; its identity is distinct from a redemption identity. */
export type ChannelPointReward = typeof ChannelPointReward.Type;

/** Schema for a Channel Point Redemption persisted by a durable workflow without EventSub routing metadata. */
export const ChannelPointRedemption = Schema.Struct({
  id: RedemptionId,
  broadcasterId: BroadcasterId,
  userId: ViewerId,
  userLogin: Schema.NonEmptyString,
  userDisplayName: Schema.NonEmptyString,
  /** Text the Viewer submitted with the redemption, such as a Song Request's Spotify link. */
  userInput: Schema.String,
  reward: ChannelPointReward,
  redeemedAt: IsoTimestamp,
});

/** Channel Point Redemption accepted by Song Request and Keyboard Raffle workflows. */
export type ChannelPointRedemption = typeof ChannelPointRedemption.Type;
