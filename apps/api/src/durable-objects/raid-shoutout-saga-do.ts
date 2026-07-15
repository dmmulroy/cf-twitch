import { Result } from "better-result";
import { z } from "zod";

import { noResultCodec, zodSagaCodec } from "../lib/codecs";
import { withRpcSerialization } from "../lib/durable-objects";
import { SagaHost, type SagaHostDefinition } from "../lib/saga-host";
import { SagaRunner, type SagaStepExecutionError } from "../lib/saga-runner";
import { TwitchService } from "../services/twitch-service";

/** Boundary schema for raid shoutout saga parameters. */
export const RaidShoutoutParamsSchema = z.object({
	messageId: z.string(),
	receivedAt: z.string(),
	raider: z.object({
		userId: z.string(),
		login: z.string(),
		displayName: z.string(),
	}),
	viewers: z.number(),
});

/** Canonical parameters persisted for one raid shoutout. */
export type RaidShoutoutParams = z.infer<typeof RaidShoutoutParamsSchema>;

/** Named persistence codec for canonical raid shoutout parameters. */
export const RaidShoutoutParamsCodec = zodSagaCodec({
	name: "raid-shoutout-params",
	codec: z.codec(RaidShoutoutParamsSchema, RaidShoutoutParamsSchema, {
		decode: (value) => value,
		encode: (value) => value,
	}),
});

const RAID_SHOUTOUT_SAGA: SagaHostDefinition<RaidShoutoutParams> = {
	sagaType: "raid-shoutout-saga",
	paramsCodec: RaidShoutoutParamsCodec,
};

/** Raid thank-you and native shoutout orchestration hosted by the shared saga lifecycle. */
class _RaidShoutoutSagaDO extends SagaHost<RaidShoutoutParams, SagaStepExecutionError> {
	protected get sagaDefinition(): SagaHostDefinition<RaidShoutoutParams> {
		return RAID_SHOUTOUT_SAGA;
	}

	protected async runSaga(
		params: RaidShoutoutParams,
		runner: SagaRunner<RaidShoutoutParams>,
	): Promise<Result<void, SagaStepExecutionError>> {
		const twitch = new TwitchService(this.env);

		const chatResult = await runner.executeStep(
			{
				name: "send-chat-thanks",
				resultCodec: noResultCodec,
				options: { timeout: 10000, maxRetries: 2 },
			},
			async () => {
				const result = await twitch.sendChatMessage(
					`Thanks for the raid @${params.raider.login}! ` +
						`Go check them out: https://twitch.tv/${params.raider.login}`,
				);

				if (result.status === "error") throw result.error;
				return { result: undefined };
			},
		);
		if (chatResult.status === "error") return Result.err(chatResult.error);

		const shoutoutResult = await runner.executeStep(
			{
				name: "create-native-shoutout",
				resultCodec: noResultCodec,
				options: { timeout: 10000, maxRetries: 2 },
			},
			async () => {
				const result = await twitch.createShoutout(params.raider.userId);

				if (result.status === "error") throw result.error;
				return { result: undefined };
			},
		);
		if (shoutoutResult.status === "error") return Result.err(shoutoutResult.error);

		return runner.complete();
	}
}

/** Production raid shoutout Durable Object with inherited serialized saga RPCs. */
export const RaidShoutoutSagaDO = withRpcSerialization(_RaidShoutoutSagaDO);
