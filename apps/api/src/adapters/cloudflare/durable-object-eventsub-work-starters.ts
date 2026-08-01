import { Result } from "better-result";

import { EventSubWorkStartError } from "../../capabilities/eventsub-work-starters";
import { StartSagaResultCodec } from "../../lib/saga-rpc-result-codecs";
import { initializeDurableObjectAgentStub } from "./durable-object-agent-stub";

import type {
	EventSubWorkStarters,
	RaidShoutoutInput,
} from "../../capabilities/eventsub-work-starters";
import type { Tracer } from "../../capabilities/tracer";
import type { KnownRewardRedemption } from "../../lib/channel-point-redemptions";
import type { Result as ResultType } from "better-result";

/** Durable Object adapter for downstream work started by accepted EventSub notifications. */
export class DurableObjectEventSubWorkStarters implements EventSubWorkStarters {
	constructor(
		private readonly songRequests: Cloudflare.Env["SONG_REQUEST_SAGA_DO"],
		private readonly keyboardRaffles: Cloudflare.Env["KEYBOARD_RAFFLE_SAGA_DO"],
		private readonly raidShoutouts: Cloudflare.Env["RAID_SHOUTOUT_SAGA_DO"],
		private readonly tracer: Tracer,
	) {}

	/** Starts one Song Request saga keyed by Channel Point Redemption ID. */
	startSongRequest(
		redemption: KnownRewardRedemption,
	): Promise<ResultType<void, EventSubWorkStartError>> {
		return this.start("song-request", redemption.id, async () => {
			const stub = await initializeDurableObjectAgentStub(
				this.songRequests.getByName(redemption.id),
				redemption.id,
			);
			return stub.start(redemption);
		});
	}

	/** Starts one Keyboard Raffle saga keyed by Channel Point Redemption ID. */
	startKeyboardRaffle(
		redemption: KnownRewardRedemption,
	): Promise<ResultType<void, EventSubWorkStartError>> {
		return this.start("keyboard-raffle", redemption.id, async () => {
			const stub = await initializeDurableObjectAgentStub(
				this.keyboardRaffles.getByName(redemption.id),
				redemption.id,
			);
			return stub.start(redemption);
		});
	}

	/** Starts one Raid Shoutout saga keyed by Twitch EventSub message ID. */
	startRaidShoutout(input: RaidShoutoutInput): Promise<ResultType<void, EventSubWorkStartError>> {
		return this.start("raid-shoutout", input.messageId, async () => {
			const stub = await initializeDurableObjectAgentStub(
				this.raidShoutouts.getByName(input.messageId),
				input.messageId,
			);
			return stub.start(input);
		});
	}

	private start(
		work: "song-request" | "keyboard-raffle" | "raid-shoutout",
		operationId: string,
		invoke: () => Promise<unknown>,
	): Promise<ResultType<void, EventSubWorkStartError>> {
		const spanName =
			work === "song-request"
				? "durable_object.song_request_saga.start"
				: work === "keyboard-raffle"
					? "durable_object.keyboard_raffle_saga.start"
					: "durable_object.raid_shoutout_saga.start";
		return this.tracer.span(spanName, { operation_id: operationId, work }, async () => {
			let rawResult: unknown;
			try {
				rawResult = await invoke();
			} catch (cause) {
				return Result.err(
					new EventSubWorkStartError({ work, operationId, failure: "transport", cause }),
				);
			}
			const parsed = await StartSagaResultCodec.deserializeUnsafe(rawResult);
			if (parsed.status === "ok") return Result.ok(undefined);
			return Result.err(
				new EventSubWorkStartError({
					work,
					operationId,
					failure: "remote",
					remoteErrorTag: parsed.error._tag,
				}),
			);
		});
	}
}
