import { describe, expect, it } from "vitest";

import {
	parseKnownRewardRedemption,
	type TwitchRedemption,
} from "../../lib/channel-point-redemptions";

function redemptionForReward(rewardId: string): TwitchRedemption {
	return {
		id: "redemption-1",
		broadcaster_user_id: "broadcaster-1",
		broadcaster_user_login: "broadcaster",
		broadcaster_user_name: "Broadcaster",
		user_id: "user-1",
		user_login: "viewer",
		user_name: "Viewer",
		user_input: "spotify:track:4iV5W9uYEdYUVa79Axb7Rh",
		status: "unfulfilled",
		reward: {
			id: rewardId,
			title: "Song Request",
			cost: 100,
			prompt: "Paste a Spotify track",
		},
		redeemed_at: "2026-01-22T12:00:00.000Z",
	};
}

describe("parseKnownRewardRedemption", () => {
	it("returns song request redemption evidence for the configured song request reward", () => {
		const result = parseKnownRewardRedemption(redemptionForReward("song-reward"), {
			songRequestRewardId: "song-reward",
			keyboardRaffleRewardId: "raffle-reward",
		});

		expect(result.status).toBe("ok");
		if (result.status === "ok") {
			expect(result.value._tag).toBe("SongRequestRedemption");
			expect(result.value.reward.id).toBe("song-reward");
		}
	});

	it("returns keyboard raffle redemption evidence for the configured raffle reward", () => {
		const result = parseKnownRewardRedemption(redemptionForReward("raffle-reward"), {
			songRequestRewardId: "song-reward",
			keyboardRaffleRewardId: "raffle-reward",
		});

		expect(result.status).toBe("ok");
		if (result.status === "ok") {
			expect(result.value._tag).toBe("KeyboardRaffleRedemption");
			expect(result.value.reward.id).toBe("raffle-reward");
		}
	});

	it("returns typed errors for unknown rewards and invalid routing config", () => {
		const unknown = parseKnownRewardRedemption(redemptionForReward("mystery-reward"), {
			songRequestRewardId: "song-reward",
			keyboardRaffleRewardId: "raffle-reward",
		});

		expect(unknown.status).toBe("error");
		if (unknown.status === "error") {
			expect(unknown.error._tag).toBe("UnknownRewardError");
		}

		const missingConfig = parseKnownRewardRedemption(redemptionForReward("song-reward"), {
			keyboardRaffleRewardId: "raffle-reward",
		});

		expect(missingConfig.status).toBe("error");
		if (missingConfig.status === "error") {
			expect(missingConfig.error._tag).toBe("RewardRoutingConfigError");
		}

		const duplicateConfig = parseKnownRewardRedemption(redemptionForReward("song-reward"), {
			songRequestRewardId: "same-reward",
			keyboardRaffleRewardId: "same-reward",
		});

		expect(duplicateConfig.status).toBe("error");
		if (duplicateConfig.status === "error") {
			expect(duplicateConfig.error._tag).toBe("RewardRoutingConfigError");
			expect(duplicateConfig.error.configKey).toBe("REWARD_ID_CONFLICT");
		}
	});
});
