import { env, runInDurableObject } from "cloudflare:test";

import { AchievementsDO } from "../../durable-objects/achievements-do";
import { TwitchTokenDO } from "../../durable-objects/twitch-token-do";

export async function createAchievementsStub(
	name: string,
): Promise<DurableObjectStub<AchievementsDO>> {
	const id = env.ACHIEVEMENTS_DO.idFromName(name);
	const stub = env.ACHIEVEMENTS_DO.get(id);
	await stub.setName(name);
	await stub.getDefinitions();
	return stub;
}

export async function ensureAchievementsSingletonStub(): Promise<DurableObjectStub<AchievementsDO>> {
	return createAchievementsStub("achievements");
}

export async function ensureNamedTwitchTokenStub(): Promise<DurableObjectStub<TwitchTokenDO>> {
	const id = env.TWITCH_TOKEN_DO.idFromName("twitch-token");
	const stub = env.TWITCH_TOKEN_DO.get(id);
	await stub.setName("twitch-token");
	await stub.getValidToken().catch(() => undefined);
	return stub;
}

export async function waitForAchievementQueuesToDrain(
	stub: DurableObjectStub<AchievementsDO>,
	userDisplayName: string,
	maxPolls = 50,
): Promise<void> {
	for (let poll = 0; poll < maxPolls; poll += 1) {
		const queuedCount = await runInDurableObject(stub, (instance: AchievementsDO) =>
			instance.getQueues("userDisplayName", userDisplayName).length,
		);

		if (queuedCount === 0) {
			return;
		}

		await new Promise((resolve) => setTimeout(resolve, 0));
	}

	throw new Error(`Timed out waiting for achievement queue to drain for ${userDisplayName}`);
}
