import { Result } from "better-result";

import { RewardRoutingConfigError, UnknownRewardError } from "./errors";

export interface TwitchRedemption {
	id: string;
	broadcaster_user_id: string;
	broadcaster_user_login: string;
	broadcaster_user_name: string;
	user_id: string;
	user_login: string;
	user_name: string;
	user_input: string;
	status: string;
	reward: {
		id: string;
		title: string;
		cost: number;
		prompt: string;
	};
	redeemed_at: string;
}

export interface SongRequestRedemption extends TwitchRedemption {
	readonly _tag: "SongRequestRedemption";
}

export interface KeyboardRaffleRedemption extends TwitchRedemption {
	readonly _tag: "KeyboardRaffleRedemption";
}

export type KnownRewardRedemption = SongRequestRedemption | KeyboardRaffleRedemption;

export interface RewardRoutingConfig {
	songRequestRewardId?: string;
	keyboardRaffleRewardId?: string;
}

export function parseKnownRewardRedemption(
	redemption: TwitchRedemption,
	config: RewardRoutingConfig,
): Result<KnownRewardRedemption, UnknownRewardError | RewardRoutingConfigError> {
	if (config.songRequestRewardId === undefined || config.songRequestRewardId.length === 0) {
		return Result.err(new RewardRoutingConfigError({ configKey: "SONG_REQUEST_REWARD_ID" }));
	}

	if (config.keyboardRaffleRewardId === undefined || config.keyboardRaffleRewardId.length === 0) {
		return Result.err(new RewardRoutingConfigError({ configKey: "KEYBOARD_RAFFLE_REWARD_ID" }));
	}

	if (config.songRequestRewardId === config.keyboardRaffleRewardId) {
		return Result.err(new RewardRoutingConfigError({ configKey: "REWARD_ID_CONFLICT" }));
	}

	if (redemption.reward.id === config.songRequestRewardId) {
		return Result.ok({ ...redemption, _tag: "SongRequestRedemption" });
	}

	if (redemption.reward.id === config.keyboardRaffleRewardId) {
		return Result.ok({ ...redemption, _tag: "KeyboardRaffleRedemption" });
	}

	return Result.err(
		new UnknownRewardError({
			redemptionId: redemption.id,
			rewardId: redemption.reward.id,
			rewardTitle: redemption.reward.title,
		}),
	);
}
