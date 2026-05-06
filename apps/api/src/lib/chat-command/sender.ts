import { Result } from "better-result";

import { TwitchService } from "../../services/twitch-service";
import { ChatCommandSendError } from "./errors";

import type { ChatSender } from "./types";

/**
 * TwitchService-backed chat sender adapter.
 *
 * @param twitch - Twitch service used to send chat messages.
 * @param message - Message text to send to Twitch chat.
 * @returns A Result indicating whether the message was sent.
 */
export class TwitchChatSender implements ChatSender {
	constructor(private readonly twitch: TwitchService) {}

	async send(message: string) {
		const result = await this.twitch.sendChatMessage(message);

		if (result.status === "error") {
			return Result.err(new ChatCommandSendError({ cause: result.error }));
		}

		return Result.ok();
	}
}
